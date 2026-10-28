import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { app, BrowserWindow } from 'electron'
import type {
  AdvancedOptions,
  AppSettings,
  CompletedItem,
  DownloadProgressPayload,
  DownloadRequest,
  DownloadTask,
  ErrorKind,
  HistoryEntry,
  HistoryStatus,
  PlaylistJob,
  StatsSummary,
  TaskState
} from '@shared/types'
import { IPC } from '@shared/types'
import { ACTIVE_STATUSES, calculateStatistics } from '@shared/statistics'
import { DownloadManager, type RunnerDeps } from '../downloader/DownloadManager'
import { cleanupDir } from '../downloader/ytdlp'
import { isStaleAnalysisFailure } from '../downloader/errors'
import { invalidateAnalyzeCache } from '../analyzer/AnalyzerManager'
import { invalidateSingleInfoCache } from '../downloader/ytdlp'
import { SettingsManager } from '../settings/SettingsManager'
import { HistoryManager } from '../history/HistoryManager'
import { CompletedManager } from '../completed/CompletedManager'
import { NotificationManager } from '../notification/NotificationManager'
import { PlaylistManager } from '../playlist/PlaylistManager'
import { hasRealTitle, isInvalidTitle, isPlaceholderItemId, stripPlaylistIndexPrefix } from '../utils/title'
import { logger } from '../utils/logger'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Full queue snapshots are expensive; only emit them at this cadence during
// high-frequency progress updates. Targeted progress events are separate.
const SNAPSHOT_EMIT_MS = 300

/** Map a live task state to its persistent History status (the stats source). */
function mapTaskStateToHistoryStatus(state: TaskState): HistoryStatus {
  switch (state) {
    case 'Waiting':
    case 'Paused':
      return 'queued'
    case 'Analyzing':
      return 'analyzing'
    case 'Downloading':
      return 'downloading'
    case 'Processing':
      return 'processing'
    case 'Converting':
      return 'converting'
    case 'Retrying':
      return 'retrying'
    case 'Completed':
      return 'completed'
    case 'Failed':
      return 'failed'
    case 'Cancelled':
      return 'cancelled'
    case 'Unavailable':
      return 'unavailable'
  }
}

const NOTIFY_I18N: Record<string, { completed: string; failed: string }> = {
  en: { completed: 'Download completed', failed: 'Download failed' },
  ar: { completed: 'اكتمل التنزيل', failed: 'فشل التنزيل' },
  fr: { completed: 'Téléchargement terminé', failed: 'Échec du téléchargement' }
}

interface PersistedTask {
  id: string
  uniqueKey?: string
  title: string
  url: string
  kind: DownloadTask['kind']
  format: string
  quality: string
  advanced?: AdvancedOptions
  thumbnail?: string
  duration?: number
  uploader?: string
  uploadDate?: string
  playlistId?: string
  playlistTitle?: string
  playlistUrl?: string
  playlistIndex?: number
  playlistCount?: number
  playlistItemId?: string
  downloadFolder?: string
  createdAt: number
  state: TaskState
  progress: DownloadTask['progress']
  attempt: number
  retryAt?: number
  error?: string
  errorDetails?: string
  errorKind?: ErrorKind
  filePath?: string
  fileSize?: number
  attemptDir?: string
}

function tempDirFor(id: string): string {
  return join(app.getPath('temp'), 'vidaud', `task-${id}`)
}

/**
 * Deterministic uniqueKey for standalone (non-playlist) jobs: derived from the
 * URL + format + kind so History keeps ONE row per job across its whole
 * lifecycle — including across Pause -> restart -> Resume.
 */
function standaloneKey(url: string, format: string, kind: string): string {
  return `standalone:${createHash('sha1').update(`${url}|${format}|${kind}`).digest('hex').slice(0, 16)}`
}

const TERMINAL: ReadonlySet<TaskState> = new Set(['Completed', 'Failed', 'Cancelled', 'Unavailable'])

export class QueueManager {
  private tasks: DownloadTask[] = []
  private jobsByKey = new Map<string, DownloadTask>()
  private requests = new Map<string, DownloadRequest>()
  private controls = new Map<string, { paused: boolean; cancelled: boolean }>()
  private downloadActive = 0
  private processingActive = 0
  private persistFile: string
  private running = new Set<string>()
  private removePending = new Set<string>()
  private snapshotTimer: NodeJS.Timeout | null = null
  private progressTimer: NodeJS.Timeout | null = null
  private progressQueue: DownloadProgressPayload[] = []
  private retryTimer: NodeJS.Timeout | null = null

  private dm = new DownloadManager()
  private settings: SettingsManager
  private history: HistoryManager
  private completed: CompletedManager
  private notifications: NotificationManager
  private playlists: PlaylistManager
  /** Last state we persisted to History per task id, to skip redundant writes. */
  private lastHistoryState = new Map<string, TaskState>()

  constructor(settings: SettingsManager, history: HistoryManager, notifications: NotificationManager, playlists: PlaylistManager, completed: CompletedManager) {
    this.settings = settings
    this.history = history
    this.completed = completed
    this.notifications = notifications
    this.playlists = playlists
    const userData = app.getPath('userData')
    if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
    this.persistFile = join(userData, 'queue-state.json')
    this.restore()
    // Rebuild History rows for every restored task and neutralise stale active
    // records (crashed sessions) so the Active count can never be inflated.
    this.reconcileHistoryWithTasks()
    // Kick off the scheduler after restore so any Waiting tasks auto-start immediately.
    setTimeout(() => this.schedule(), 500)
  }

  // -------------------------------------------------------------------------

  /**
   * Write (or update) the persistent History row for a task. The History Store
   * is the single source of truth for Dashboard/Header statistics, so every
   * meaningful task state transition ends up here.
   */
  private recordHistoryStatus(task: DownloadTask, status: HistoryStatus): void {
    if (!task.uniqueKey) return
    this.history.upsert({
      uniqueKey: task.uniqueKey,
      fileName: task.filePath ? basename(task.filePath) : task.title,
      type: task.kind,
      size: task.fileSize ?? 0,
      status,
      path: task.filePath ?? '',
      url: task.url,
      playlistId: task.playlistId,
      playlistTitle: task.playlistTitle,
      playlistIndex: task.playlistIndex,
      playlistCount: task.playlistCount
    })
  }

  /** Persist the task's current state to History, skipping no-op repeats. */
  private syncHistory(task: DownloadTask, force = false): void {
    const prev = this.lastHistoryState.get(task.id)
    if (!force && prev === task.state) return
    this.lastHistoryState.set(task.id, task.state)
    this.recordHistoryStatus(task, mapTaskStateToHistoryStatus(task.state))
  }

  /**
   * On startup: re-sync every restored task into History and mark stale active
   * records (from a crashed/closed session) as `cancelled` so the Active count
   * always reflects real live tasks only.
   */
  private reconcileHistoryWithTasks(): void {
    for (const t of this.tasks) {
      this.lastHistoryState.delete(t.id)
      this.syncHistory(t)
    }
    const liveKeys = new Set(this.tasks.map((t) => t.uniqueKey))
    for (const e of this.history.list()) {
      if (ACTIVE_STATUSES.has(e.status) && e.uniqueKey && !liveKeys.has(e.uniqueKey)) {
        this.history.upsert({ ...e, status: 'cancelled' })
      }
    }
  }

  addRequest(req: DownloadRequest): { ok: boolean; taskIds: string[]; error?: string; skipped?: number; unavailable?: number } {
    const settings = this.settings.get()
    const entries = req.entries && req.entries.length > 0 ? req.entries : [{ id: 'main', url: req.url, title: req.title ?? req.url, index: 1 }]
    const isPlaylist = !!(req.playlistUrl && entries.length > 1)

    // Create the playlist-named folder up front so the download has a target.
    if (req.downloadFolder) {
      try {
        if (!existsSync(req.downloadFolder)) mkdirSync(req.downloadFolder, { recursive: true })
      } catch (e) {
        logger.warn(`playlist folder create failed: ${e}`)
      }
    }

    const job = isPlaylist ? this.playlists.ensureJob(req, entries, req.downloadFolder) : undefined
    const taskIds: string[] = []
    let skipped = 0
    let unavailable = 0
    const autoStart = settings.startAutomatically

    for (const e of entries) {
      const itemId = e.id || `item-${e.index ?? taskIds.length + 1}`
      // Standalone multi-entry requests (image galleries) carry a distinct URL
      // per entry, so the key is derived per entry — otherwise every gallery
      // image would collide on the page URL and only the first would queue.
      const keyUrl = !isPlaylist && entries.length > 1 ? e.url || req.url : req.url
      const uniqueKey = isPlaylist && req.playlistId ? `${req.playlistId}:${itemId}:${req.format}` : standaloneKey(keyUrl, req.format, req.kind)
      const entryMeta = { id: itemId, title: e.title, url: e.url || '', index: e.index, duration: e.duration, thumbnail: e.thumbnail, uploader: e.uploader }

      const hasUrl = typeof e.url === 'string' && e.url.trim().length > 0 && e.available !== false

      // Playlist items must carry a real title, a stable id AND a valid URL
      // before a download job is ever created. An invalid item is excluded
      // (never queued) — no fake "Untitled"/"Unknown" fallback title is used.
      const invalidEntry = isPlaylist ? !hasRealTitle(e.title) || isPlaceholderItemId(e.id) || !hasUrl : !hasUrl
      if (invalidEntry) {
        unavailable += 1
        const excludeReason = !hasUrl ? 'missing_url' : isPlaceholderItemId(e.id) ? 'missing_id' : typeof e.title === 'string' && e.title.trim() ? 'invalid_title' : 'missing_title'
        logger.debug(`[VIDAUD][PLAYLIST] Item excluded / Reason: ${excludeReason} / Index: ${e.index ?? taskIds.length + 1} / Title: ${isInvalidTitle(e.title) ? '(no real title)' : stripPlaylistIndexPrefix(e.title)}`)
        if (job) {
          this.playlists.getOrCreateItem(job, entryMeta)
          this.playlists.updateItem(job.playlistId, itemId, {
            status: 'Unavailable',
            error: !hasUrl ? 'This item has no valid URL and cannot be downloaded.' : 'This item has no valid title and cannot be downloaded.'
          })
        }
        continue
      }

      if (job) {
        const item = this.playlists.getOrCreateItem(job, entryMeta)
        // Re-adding a playlist downloads EVERYTHING that is not already
        // completed. Previously Cancelled / Failed items are re-queued so a
        // transient failure never leaves an item out forever. Permanently
        // excluded items are never in this list.
        if (item.status === 'Completed') {
          skipped += 1
          continue
        }
      }

      // Existing live task: keep non-terminal ones (already in progress), but
      // re-queue terminal ones so re-adding the playlist retries every item
      // that previously failed or was cancelled.
      const existing = this.jobsByKey.get(uniqueKey)
      if (existing) {
        if (existing.state === 'Completed') {
          skipped += 1
          continue
        }
        if (TERMINAL.has(existing.state)) {
          logger.info(`[VIDAUD][QUEUE] Re-queuing terminal task ${existing.id} for uniqueKey = ${uniqueKey} (was ${existing.state})`)
          existing.state = 'Waiting'
          existing.attempt = 0
          existing.retryAt = undefined
          existing.error = undefined
          existing.errorDetails = undefined
          existing.errorKind = undefined
          existing.progress = { percent: 0, downloadedBytes: 0, stage: 'queued' }
          existing.autoStart = true
          this.controls.set(existing.id, { paused: false, cancelled: false })
          this.playlists.syncItemFromTask(existing)
          this.syncHistory(existing)
          taskIds.push(existing.id)
          continue
        }
        logger.info(`[VIDAUD][QUEUE] Job already exists for uniqueKey = ${uniqueKey}. Returning existing job.`)
        skipped += 1
        continue
      }

      // Standalone (non-playlist) jobs carry a deterministic uniqueKey, so
      // re-adding the same URL + format reuses the existing live job instead
      // of creating a duplicate (which would corrupt the History row). A
      // terminal job is re-queued for a fresh attempt with a fresh temp dir.
      if (!job) {
        const existing = this.jobsByKey.get(uniqueKey)
        if (existing) {
          if (TERMINAL.has(existing.state)) {
            logger.info(`[VIDAUD][QUEUE] Re-queuing standalone task ${existing.id} for uniqueKey = ${uniqueKey} (was ${existing.state})`)
            existing.state = 'Waiting'
            existing.attempt = 0
            existing.retryAt = undefined
            existing.error = undefined
            existing.errorDetails = undefined
            existing.errorKind = undefined
            existing.attemptDir = undefined
            existing.progress = { percent: 0, downloadedBytes: 0, stage: 'queued' }
            existing.autoStart = true
            this.controls.set(existing.id, { paused: false, cancelled: false })
            this.syncHistory(existing)
            taskIds.push(existing.id)
            continue
          }
          logger.info(`[VIDAUD][QUEUE] Standalone job already exists for uniqueKey = ${uniqueKey}. Returning existing job.`)
          skipped += 1
          taskIds.push(existing.id)
          continue
        }
      }

      const id = randomUUID()
      // Internal data model: playlistIndex stays separate metadata (ordering/UI
      // only). The title — and therefore the filename — is always the real
      // title, never "01 - Title". Opt-in numbering (if ever enabled) applies
      // at filename-generation time only, never here.
      const task: DownloadTask = {
        id,
        uniqueKey,
        title: e.title,
        url: e.url,
        kind: req.kind,
        format: req.format,
        quality: req.quality,
        thumbnail: e.thumbnail || req.thumbnail,
        duration: e.duration ?? req.duration,
        playlistId: isPlaylist ? req.playlistId : undefined,
        playlistTitle: isPlaylist ? req.playlistTitle : undefined,
        playlistUrl: isPlaylist ? req.playlistUrl : undefined,
        playlistIndex: isPlaylist ? e.index : undefined,
        playlistCount: isPlaylist ? req.playlistCount ?? entries.length : undefined,
        playlistItemId: isPlaylist ? itemId : undefined,
        downloadFolder: req.downloadFolder,
        state: 'Waiting',
        progress: { percent: 0, downloadedBytes: 0, stage: 'queued' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 0,
        tempDir: tempDirFor(id),
        autoStart
      }
      this.tasks.push(task)
      this.jobsByKey.set(uniqueKey, task)
      this.syncHistory(task)
      const singleReq: DownloadRequest = {
        url: e.url,
        kind: req.kind,
        format: req.format,
        quality: req.quality,
        advanced: req.advanced,
        title: e.title,
        thumbnail: e.thumbnail || req.thumbnail,
        duration: e.duration ?? req.duration,
        uploader: e.uploader || req.uploader,
        uploadDate: req.uploadDate,
        playlistId: isPlaylist ? req.playlistId : undefined,
        playlistTitle: isPlaylist ? req.playlistTitle : undefined,
        downloadFolder: req.downloadFolder
      }
      this.requests.set(id, singleReq)
      this.controls.set(id, { paused: false, cancelled: false })
      taskIds.push(id)
      if (job) {
        this.playlists.updateItem(job.playlistId, itemId, { taskId: id, status: 'Waiting', attempt: 0, error: undefined, errorDetails: undefined, errorKind: undefined })
      }
      logger.info(`queued task ${id}: ${e.title} (${req.kind}/${req.format}/${req.quality})`)
    }

    this.persist()
    this.emit()
    this.schedule()
    return { ok: true, taskIds, skipped, unavailable }
  }

  getPlaylists(): PlaylistJob[] {
    return this.playlists.list()
  }

  // -------------------------------------------------------------------------
  // Controls

  pause(id: string): void {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return
    const control = this.controls.get(id)
    // Also accept Processing / Converting: the DownloadManager FFmpeg kill loop
    // now honors `control.paused`, so a pause during merge/convert actually
    // stops FFmpeg and the worker returns 'paused' (attempt dir is preserved).
    if (control && (task.state === 'Downloading' || task.state === 'Waiting' || task.state === 'Analyzing' || task.state === 'Processing' || task.state === 'Converting')) {
      control.paused = true
      if (task.state === 'Waiting' || task.state === 'Analyzing') {
        task.state = 'Paused'
        task.progress = { ...task.progress, stage: 'paused', message: 'Paused' }
        this.playlists.syncItemFromTask(task)
        this.syncHistory(task)
        this.persist()
        this.emit()
      }
    }
  }

  resume(id: string): void {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return
    if (task.state !== 'Paused' && task.state !== 'Waiting') return
    this.controls.set(id, { paused: false, cancelled: false })
    task.state = 'Waiting'
    task.autoStart = true
    task.progress = { ...task.progress, stage: 'queued', message: undefined }
    task.error = undefined
    task.errorDetails = undefined
    task.errorKind = undefined
    task.attempt = 0
    task.retryAt = undefined
    this.playlists.syncItemFromTask(task)
    this.syncHistory(task)
    this.persist()
    this.emit()
    this.schedule()
  }

  cancel(id: string): void {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return
    logger.info(`[queue] cancel called for ${id} (state=${task.state})`)
    const control = this.controls.get(id)
    if (control) control.cancelled = true
    if (task.state === 'Waiting' || task.state === 'Paused' || task.state === 'Retrying') {
      task.state = 'Cancelled'
      task.retryAt = undefined
      task.attemptDir = undefined
      this.cleanupTaskFiles(id)
      this.playlists.syncItemFromTask(task)
      this.syncHistory(task)
      this.persist()
      this.emit()
      this.schedule()
    }
  }

  retry(id: string): void {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return
    if (task.state !== 'Failed' && task.state !== 'Cancelled') return
    this.controls.set(id, { paused: false, cancelled: false })
    task.state = 'Waiting'
    task.progress = { percent: 0, downloadedBytes: 0, stage: 'queued' }
    task.error = undefined
    task.errorDetails = undefined
    task.errorKind = undefined
    task.attempt = 0
    task.attemptDir = undefined
    task.retryAt = undefined
    this.playlists.syncItemFromTask(task)
    this.syncHistory(task)
    this.persist()
    this.emit()
    this.schedule()
  }

  /** Per-item manual retry for playlist items (works even after tasks were cleared). */
  retryPlaylistItem(playlistId: string, itemId: string): void {
    const job = this.playlists.getJob(playlistId)
    if (!job) return
    const item = job.items.find((i) => i.itemId === itemId)
    if (!item) return
    if (item.status === 'Unavailable') return
    // Never re-create a job for an item that has no real title/URL/id: it is
    // excluded, not retryable (no Retry / Pause / Resume / Cancel for it).
    if (isInvalidTitle(item.title) || typeof item.url !== 'string' || !item.url.trim() || isPlaceholderItemId(item.itemId)) {
      logger.debug(`[VIDAUD][PLAYLIST] Retry blocked for excluded item / Reason: invalid / Index: ${item.index}`)
      return
    }

    // Search by uniqueKey to prevent duplicates
    const uniqueKey = `${playlistId}:${itemId}:${job.format}`
    const existing = this.jobsByKey.get(uniqueKey)
    if (existing) {
      if (existing.state === 'Failed' || existing.state === 'Cancelled') {
        this.retry(existing.id)
      }
      return
    }
    // No live task (e.g. it was cleared): recreate it from the job item.
    const id = randomUUID()
    const task: DownloadTask = {
      id,
      uniqueKey,
      title: item.title,
      url: item.url,
      kind: job.kind,
      format: job.format,
      quality: job.quality,
      thumbnail: item.thumbnail,
      duration: item.duration,
      playlistId: job.playlistId,
      playlistTitle: job.playlistTitle,
      playlistUrl: job.playlistUrl,
      playlistIndex: item.index,
      playlistCount: job.totalItems,
      playlistItemId: item.itemId,
      downloadFolder: job.downloadFolder,
      state: 'Waiting',
      progress: { percent: 0, downloadedBytes: 0, stage: 'queued' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempt: 0,
      tempDir: tempDirFor(id),
      autoStart: true
    }
    this.tasks.push(task)
    this.jobsByKey.set(uniqueKey, task)
    this.syncHistory(task)
    const singleReq: DownloadRequest = {
      url: item.url,
      kind: job.kind,
      format: job.format,
      quality: job.quality,
      advanced: job.advanced,
      title: item.title,
      thumbnail: item.thumbnail,
      duration: item.duration,
      uploader: item.uploader,
      playlistId: job.playlistId,
      playlistTitle: job.playlistTitle,
      downloadFolder: job.downloadFolder
    }
    this.requests.set(id, singleReq)
    this.controls.set(id, { paused: false, cancelled: false })
    this.playlists.updateItem(job.playlistId, itemId, { taskId: id, status: 'Waiting', attempt: 0, error: undefined, errorDetails: undefined, errorKind: undefined })
    this.persist()
    this.emit()
    this.schedule()
  }

  retryPlaylistFailed(playlistId: string): number {
    const job = this.playlists.getJob(playlistId)
    if (!job) return 0
    const targets = job.items.filter((i) => i.status === 'Failed')
    for (const item of targets) this.retryPlaylistItem(playlistId, item.itemId)
    return targets.length
  }

  remove(id: string): void {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return
    const control = this.controls.get(id)
    if (control && (task.state === 'Downloading' || task.state === 'Processing' || task.state === 'Converting' || task.state === 'Analyzing')) {
      control.cancelled = true
      this.removePending.add(id)
      return
    }
    // Removing a finished job from the Downloads list must not rewrite its
    // History status (a completed file stays 'completed' in History).
    if (task.state !== 'Completed') this.recordHistoryStatus(task, 'cancelled')
    this.cleanupTaskFiles(id)
    this.tasks = this.tasks.filter((t) => t.id !== id)
    this.jobsByKey.delete(task.uniqueKey)
    this.requests.delete(id)
    this.controls.delete(id)
    this.persist()
    this.emit()
    this.schedule()
  }

  pauseAll(): void {
    for (const t of this.tasks) this.pause(t.id)
  }

  resumeAll(): void {
    for (const t of this.tasks) this.resume(t.id)
  }

  /** Returns true if any download is actively running (not paused/terminal). */
  hasActiveDownloads(): boolean {
    return this.tasks.some(
      (t) => t.state === 'Downloading' || t.state === 'Processing' || t.state === 'Converting' || t.state === 'Analyzing' || t.state === 'Waiting' || t.state === 'Retrying'
    )
  }

  /** Cancel all tasks belonging to a playlist and remove the playlist job record. */
  removePlaylist(playlistId: string): void {
    // Cancel all non-terminal tasks for this playlist
    for (const task of this.tasks) {
      if (task.playlistId !== playlistId) continue
      if (TERMINAL.has(task.state)) continue
      const control = this.controls.get(task.id)
      if (control) control.cancelled = true
      task.state = 'Cancelled'
      task.retryAt = undefined
      task.progress = { ...task.progress, stage: 'cancelled' }
      if (!this.running.has(task.id)) this.cleanupTaskFiles(task.id)
      this.syncHistory(task)
    }
    // Remove all tasks for this playlist from the queue (terminal or not)
    const removed = this.tasks.filter((t) => t.playlistId === playlistId)
    for (const t of removed) {
      this.jobsByKey.delete(t.uniqueKey)
      this.requests.delete(t.id)
      this.controls.delete(t.id)
    }
    this.tasks = this.tasks.filter((t) => t.playlistId !== playlistId)
    // Remove the persistent playlist job record
    this.playlists.removeJob(playlistId)
    this.persist()
    this.emit()
  }

  cancelAll(): void {
    // Mark every non-terminal task as Cancelled immediately so the UI
    // reflects the change right away (active tasks get the cancel signal
    // AND their state is set so the UI shows Cancelled immediately).
    for (const task of this.tasks) {
      if (TERMINAL.has(task.state)) continue
      const control = this.controls.get(task.id)
      if (control) control.cancelled = true
      // Immediately set state so UI updates right away
      task.state = 'Cancelled'
      task.retryAt = undefined
      task.progress = { ...task.progress, stage: 'cancelled' }
      this.playlists.syncItemFromTask(task)
      this.syncHistory(task)
    }
    // Clean up temp files for all cancelled tasks that are not currently
    // running (running ones will clean up when their runner exits).
    for (const task of this.tasks) {
      if (task.state === 'Cancelled' && !this.running.has(task.id)) {
        this.cleanupTaskFiles(task.id)
      }
    }
    this.persist()
    this.emit()
  }

  /**
   * Clear Completed on the Downloads list only.
   *
   * Removes every task with state `Completed` from the live queue AND every
   * completed item from the playlist job items (those are the "Completed" rows
   * rendered under playlist sections). Nothing else is touched:
   *   - files on disk are never deleted,
   *   - the Completed library is left intact,
   *   - History is left intact,
   *   - Downloading / Processing / Converting / Validating / Waiting /
   *     Analyzing / Retrying / Paused / Failed / Cancelled stay in Downloads.
   *
   * The operation is synchronous within the event loop, so a task that is still
   * `Downloading` when the call begins can never be swept up, and a task that
   * transitions to `Completed` during the call is handled by handleCompleted.
   */
  async clearCompleted(): Promise<{ success: boolean; removedIds: string[]; count: number }> {
    try {
      logger.info('[VIDAUD][DOWNLOADS] Clear Completed requested')
      const removedIds: string[] = []

      // 1) Completed live tasks (standalone / edge cases still in the queue).
      const completedTasks = this.tasks.filter((t) => t.state === 'Completed')
      for (const c of completedTasks) {
        this.jobsByKey.delete(c.uniqueKey)
        this.requests.delete(c.id)
        this.controls.delete(c.id)
        this.running.delete(c.id)
        removedIds.push(c.id)
      }
      this.tasks = this.tasks.filter((t) => t.state !== 'Completed')

      // 2) Completed playlist items -> drop their rows from playlist sections.
      //    Also covers every persisted job, not just ones with live tasks.
      const playlistIds = new Set<string>()
      for (const job of this.playlists.list()) playlistIds.add(job.playlistId)
      for (const pid of playlistIds) {
        const itemIds = this.playlists.clearCompletedItems(pid)
        for (const iid of itemIds) removedIds.push(`playlist:${pid}:${iid}`)
      }

      this.persist()
      this.emit()

      logger.info(`[VIDAUD][DOWNLOADS] Completed jobs found: ${removedIds.length}`)
      logger.info(`[VIDAUD][DOWNLOADS] Removed jobs: ${removedIds.length}`)
      logger.info(`[VIDAUD][DOWNLOADS] Active jobs remaining: ${this.tasks.length}`)
      return { success: true, removedIds, count: removedIds.length }
    } catch (e) {
      logger.error(`[VIDAUD][DOWNLOADS] Clear Completed failed: ${e instanceof Error ? e.message : String(e)}`)
      return { success: false, removedIds: [], count: 0 }
    }
  }

  getQueue(): DownloadTask[] {
    return [...this.tasks]
  }

  getCompletedItems(): CompletedItem[] {
    return this.completed.list()
  }

  getStats(): StatsSummary {
    return calculateStatistics(this.history.list())
  }

  // -------------------------------------------------------------------------
  // Scheduling

  private schedule(): void {
    const cfg = this.settings.get()
    // Download slots are the only hard limit for starting work: processing
    // (FFmpeg) tasks run concurrently with downloads under their own gate, so
    // `schedule()` dispatches purely off the free download slots. The running
    // worker cap keeps CPU/RAM bounded (downloads + one processing lane + headroom).
    const downloadSlots = Math.max(0, cfg.maxSimultaneousDownloads - this.downloadActive)
    const workerCap = cfg.maxSimultaneousDownloads + Math.max(1, cfg.maxConcurrentProcessing)
    const waiting = this.tasks.filter((t) => t.state === 'Waiting' && t.autoStart !== false)
    if (waiting.length > 0) {
      logger.info(`[VIDAUD][QUEUE] Scheduler: downloadActive=${this.downloadActive}, processingActive=${this.processingActive}, slots=${downloadSlots}, waiting=${waiting.length}, maxSimultaneous=${cfg.maxSimultaneousDownloads}`)
    }
    let started = 0
    for (const task of waiting) {
      if (started >= downloadSlots) break
      if (this.running.size >= workerCap) break
      if (this.running.has(task.id)) continue
      started += 1
      logger.info(`[VIDAUD][QUEUE] Starting worker for task ${task.id}: ${task.title}`)
      this.running.add(task.id)
      void this.runTask(task)
    }
  }

  private async runTask(task: DownloadTask): Promise<void> {
    const req = this.requests.get(task.id)
    if (!req) {
      this.running.delete(task.id)
      return
    }
    const control = this.controls.get(task.id) ?? { paused: false, cancelled: false }
    const deps: RunnerDeps = {
      settings: () => this.settings.get(),
      control,
      isAborted: () => control.paused || control.cancelled,
      onUpdate: (t) => this.handleUpdate(t),
      onProgress: (p) => this.emitProgress(p),
      onCompleted: (t, path, size, skipped) => this.handleCompleted(t, path, size, skipped),
      onFailed: (t, message, details) => this.markTerminal(t, 'Failed', message, details, 'unknown'),
      acquireDownload: async () => this.acquireDownload(control),
      releaseDownload: () => {
        this.downloadActive = Math.max(0, this.downloadActive - 1)
        // A freed download slot can host the next queued item while this task
        // still runs its FFmpeg processing lane (spec: download + processing
        // overlap under their own limits).
        this.schedule()
      },
      acquireProcessing: async () => this.acquireProcessing(control),
      releaseProcessing: () => {
        this.processingActive = Math.max(0, this.processingActive - 1)
        this.schedule()
      }
    }

    try {
      task.attempt = (task.attempt ?? 0) + 1
      this.handleUpdate(task)
      const result = await this.dm.runTask(task, req, deps)

      if (result.state === 'paused') {
        this.markPaused(task)
      } else if (result.state === 'cancelled') {
        this.markCancelled(task)
      } else       if (result.state === 'failed') {
        const maxAttempts = 1 + Math.max(0, this.settings.get().retryCount)
        const kind = result.errorKind ?? 'unknown'
        if (kind === 'permanent') {
          this.excludeTask(task, result.error ?? 'This video is unavailable or has been removed.')
        } else if ((kind === 'temporary' || kind === 'unknown') && task.attempt < maxAttempts && !control.cancelled && !control.paused) {
          // A 403/expired/signature failure means the analyzed stream URL is
          // stale: drop it from the analyze cache so the retry re-analyzes
          // with fresh metadata instead of reusing the dead stream (spec).
          if (isStaleAnalysisFailure(`${result.error ?? ''}\n${result.errorDetails ?? ''}`)) {
            invalidateAnalyzeCache(req.url)
            invalidateSingleInfoCache(req.url)
          }
          this.scheduleRetry(task, result.error ?? 'Temporary failure.', result.errorDetails ?? '')
        } else {
          this.markTerminal(task, 'Failed', result.error ?? 'Unable to download this file.', result.errorDetails ?? '', kind)
        }
      }
    } catch (e) {
      logger.error(`unexpected runner error: ${e}`)
      this.markTerminal(task, 'Failed', 'Unable to download this file.', e instanceof Error ? e.message : String(e), 'unknown')
    } finally {
      this.running.delete(task.id)
      this.schedule()
    }
  }

  private async acquireDownload(control: { paused: boolean; cancelled: boolean }): Promise<boolean> {
    const limit = this.settings.get().maxSimultaneousDownloads
    while (this.downloadActive >= limit) {
      if (control.cancelled || control.paused) return false
      await delay(250)
    }
    this.downloadActive += 1
    return true
  }

  private async acquireProcessing(control: { paused: boolean; cancelled: boolean }): Promise<boolean> {
    const limit = this.settings.get().maxConcurrentProcessing
    while (this.processingActive >= limit) {
      if (control.cancelled || control.paused) return false
      await delay(250)
    }
    this.processingActive += 1
    return true
  }

  // -------------------------------------------------------------------------
  // Retry orchestration (temporary failures, exponential backoff: 1s 2s 4s 8s)

  private scheduleRetry(task: DownloadTask, message: string, details: string): void {
    const found = this.tasks.find((x) => x.id === task.id)
    if (!found) return
    // Exponential backoff driven by the retry delay setting: base, 2x, 4x, 8x,
    // capped at 8x so retries never sleep forever (spec: 1s 2s 4s 8s, then stop).
    const base = Math.max(1, this.settings.get().retryDelaySeconds)
    const backoffMs = Math.min(base * 8, base * 1000 * Math.pow(2, Math.max(0, task.attempt - 1)))
    found.state = 'Retrying'
    found.error = message
    found.errorDetails = details
    found.errorKind = 'temporary'
    found.retryAt = Date.now() + backoffMs
    // A retry starts over with a fresh attempt dir (spec: never reuse a failed
    // attempt's temp files), so clear the pointer to the discarded attempt.
    found.attemptDir = undefined
    found.progress = { percent: 0, indeterminate: true, downloadedBytes: 0, stage: 'retry', phase: 'retry', message: `Retrying in ${Math.ceil(backoffMs / 1000)}s (attempt ${task.attempt + 1})` }
    this.playlists.syncItemFromTask(found)
    this.persist()
    this.emit()
    this.armRetryTimer()
  }

  private armRetryTimer(): void {
    if (this.retryTimer) return
    const now = Date.now()
    const due = this.tasks.filter((t) => t.state === 'Retrying' && t.retryAt !== undefined)
    if (due.length === 0) return
    const earliest = Math.min(...due.map((t) => t.retryAt as number))
    const wait = Math.max(100, earliest - now)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      const now2 = Date.now()
      for (const t of this.tasks) {
        if (t.state === 'Retrying' && t.retryAt !== undefined && t.retryAt <= now2) {
          // If the task was cancelled while waiting for retry, keep it cancelled.
          const c = this.controls.get(t.id)
          if (c?.cancelled) {
            t.state = 'Cancelled'
            t.retryAt = undefined
            t.progress = { ...t.progress, stage: 'cancelled' }
            this.cleanupTaskFiles(t.id)
            this.playlists.syncItemFromTask(t)
            this.syncHistory(t)
            continue
          }
          t.state = 'Waiting'
          t.retryAt = undefined
          t.progress = { ...t.progress, stage: 'queued', message: undefined }
          if (c) {
            c.paused = false
            c.cancelled = false
          }
          this.playlists.syncItemFromTask(t)
          this.syncHistory(t)
        }
      }
      this.persist()
      this.emit()
      this.schedule()
      this.armRetryTimer()
    }, wait)
  }

  // -------------------------------------------------------------------------

  private handleUpdate(task: DownloadTask): void {
    const idx = this.tasks.findIndex((t) => t.id === task.id)
    if (idx >= 0) {
      const next = { ...task, updatedAt: Date.now() }
      this.tasks[idx] = next
      this.playlists.syncItemFromTask(next)
      this.syncHistory(next)
      this.emitThrottled()
    }
  }

  /** High-frequency targeted progress event for a single task (no full snapshot). */
  private emitProgress(p: DownloadProgressPayload): void {
    this.progressQueue.push(p)
    if (this.progressTimer) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      const batch = this.progressQueue
      this.progressQueue = []
      // Only the latest sample per task matters.
      const latest = new Map<string, DownloadProgressPayload>()
      for (const x of batch) latest.set(x.id, x)
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || !win.webContents) continue
        for (const payload of latest.values()) {
          win.webContents.send(IPC.events.progress, payload)
        }
      }
    }, 120)
  }

  private emitThrottled(): void {
    if (this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null
      this.emit()
    }, SNAPSHOT_EMIT_MS)
  }

  private handleCompleted(t: DownloadTask, path: string, size: number, skipped: boolean): void {
    const task = this.tasks.find((x) => x.id === t.id)
    if (!task) return
    task.state = 'Completed'
    task.progress = { percent: 100, downloadedBytes: size, totalBytes: size, stage: 'done' }
    task.filePath = path
    task.fileSize = size
    task.error = undefined
    task.errorKind = undefined

    logger.info(`[VIDAUD][QUEUE] Job completed: ${task.title} -> ${path} (${size} bytes, skipped=${skipped})`)

    // Register the completed file in the persistent Completed library BEFORE
    // the task leaves the Downloads queue. The file itself is never moved.
    if (!skipped) {
      if (!this.completed) {
        logger.error('[VIDAUD][COMPLETED] CRITICAL: this.completed is undefined! completed was not passed to QueueManager constructor.')
      } else {
        try {
          this.completed.add({
            uniqueKey: task.uniqueKey,
            title: task.title,
            filePath: path,
            format: task.format,
            type: task.kind,
            size,
            thumbnail: task.thumbnail,
            quality: task.quality,
            sourceUrl: task.url,
            playlistId: task.playlistId,
            playlistTitle: task.playlistTitle,
            playlistIndex: task.playlistIndex
          })
        } catch (e) {
          logger.error(`[VIDAUD][COMPLETED] add() failed: ${e instanceof Error ? e.stack : String(e)}`)
        }
      }
    }

    this.playlists.syncItemFromTask(task)
    // Keep standalone completed jobs visible in the Downloads list until the
    // user clears them (Clear Completed). Playlist rows are rendered from the
    // playlist job, so those tasks are removed here to avoid duplication; their
    // completed status lives on in the playlist job item instead.
    if (task.playlistId) {
      this.tasks = this.tasks.filter((x) => x.id !== task.id)
      this.jobsByKey.delete(task.uniqueKey)
      this.controls.delete(task.id)
    }
    this.requests.delete(task.id)
    this.running.delete(task.id)
    this.persist()
    this.syncHistory(task, true)
    if (this.settings.get().notifications) {
      const lang = NOTIFY_I18N[this.settings.get().language] ?? NOTIFY_I18N.en
      this.notifications.show({ title: lang.completed, body: path.split(/[\\/]/).pop() ?? '', clickAction: 'folder', filePath: path })
    }
    this.emit()
    this.schedule()
    if (this.settings.get().openFolderAfterDownload && !skipped) {
      const { shell } = require('electron') as typeof import('electron')
      void shell.showItemInFolder(path)
    }
  }

  /** Terminal failure: records stats + history + notification exactly once. */
  private markTerminal(task: DownloadTask, state: 'Failed', message: string, details: string, errorKind: ErrorKind): void {
    const found = this.tasks.find((x) => x.id === task.id)
    if (!found) return
    found.state = state
    found.error = message
    found.errorDetails = details
    found.errorKind = errorKind
    found.attemptDir = undefined
    this.playlists.syncItemFromTask(found)
    this.persist()
    this.syncHistory(found, true)
    if (this.settings.get().notifications) {
      const lang = NOTIFY_I18N[this.settings.get().language] ?? NOTIFY_I18N.en
      this.notifications.show({ title: lang.failed, body: found.title, clickAction: 'downloads' })
    }
    this.emit()
    this.schedule()
  }

  /** Permanent failure (removed / private / region-restricted / DRM / invalid):
   *  the item is excluded entirely — no "Unavailable" card, no retry button,
   *  no progress impact. The playlist job item records the exclusion so it
   *  never re-queues on re-add or restart, but the live task is removed. */
  private excludeTask(task: DownloadTask, message: string): void {
    const found = this.tasks.find((x) => x.id === task.id)
    if (!found) return
    const reason = message || 'This video is unavailable or has been removed.'
    logger.debug(`[VIDAUD][PLAYLIST] Item excluded / Reason: unavailable / ${found.title} / ${reason}`)
    if (found.playlistId && found.playlistItemId) {
      this.playlists.updateItem(found.playlistId, found.playlistItemId, {
        status: 'Unavailable',
        error: reason,
        errorDetails: found.errorDetails,
        errorKind: 'permanent'
      })
    }
    this.tasks = this.tasks.filter((x) => x.id !== found.id)
    this.jobsByKey.delete(found.uniqueKey)
    this.requests.delete(found.id)
    this.controls.delete(found.id)
    this.cleanupTaskFiles(found.id)
    this.recordHistoryStatus(found, 'unavailable')
    this.persist()
    this.emit()
  }

  private markPaused(task: DownloadTask): void {
    const found = this.tasks.find((x) => x.id === task.id)
    if (!found) return
    found.state = 'Paused'
    found.progress = { ...found.progress, stage: 'paused', message: 'Paused' }
    this.playlists.syncItemFromTask(found)
    this.syncHistory(found)
    this.persist()
    this.emit()
    this.schedule()
  }

  private markCancelled(task: DownloadTask): void {
    const found = this.tasks.find((x) => x.id === task.id)
    if (!found) return
    found.state = 'Cancelled'
    found.progress = { ...found.progress, stage: 'cancelled' }
    found.retryAt = undefined
    found.attemptDir = undefined
    this.cleanupTaskFiles(found.id)
    this.playlists.syncItemFromTask(found)
    this.syncHistory(found)
    if (this.removePending.has(found.id)) {
      this.removePending.delete(found.id)
      this.tasks = this.tasks.filter((x) => x.id !== found.id)
      this.jobsByKey.delete(found.uniqueKey)
      this.requests.delete(found.id)
      this.controls.delete(found.id)
    }
    this.persist()
    this.emit()
    this.schedule()
  }

  private cleanupTaskFiles(id: string): void {
    try {
      cleanupDir(tempDirFor(id))
    } catch (e) {
      logger.warn(`cleanup task files failed ${id}: ${e}`)
    }
  }

  // -------------------------------------------------------------------------
  // Persistence (restore interrupted downloads on app restart)

  private persist(): void {
    try {
      const data: PersistedTask[] = this.tasks.map((t) => {
        const req = this.requests.get(t.id)
        return {
          id: t.id,
          uniqueKey: t.uniqueKey,
          title: t.title,
          url: t.url,
          kind: t.kind,
          format: t.format,
          quality: t.quality,
          advanced: req?.advanced,
          thumbnail: t.thumbnail,
          duration: t.duration,
          uploader: req?.uploader,
          uploadDate: req?.uploadDate,
          playlistId: t.playlistId,
          playlistTitle: t.playlistTitle,
          playlistUrl: t.playlistUrl,
          playlistIndex: t.playlistIndex,
          playlistCount: t.playlistCount,
          playlistItemId: t.playlistItemId,
          downloadFolder: t.downloadFolder,
          createdAt: t.createdAt,
          state: t.state,
          progress: t.progress,
          attempt: t.attempt,
          retryAt: t.retryAt,
          error: t.error,
          errorDetails: t.errorDetails,
          errorKind: t.errorKind,
          filePath: t.filePath,
          fileSize: t.fileSize,
          attemptDir: t.attemptDir
        }
      })
      writeFileSync(this.persistFile, JSON.stringify(data), 'utf-8')
    } catch (e) {
      logger.error(`queue persist failed: ${e}`)
    }
  }

  private restore(): void {
    try {
      if (!existsSync(this.persistFile)) return
      const data = JSON.parse(readFileSync(this.persistFile, 'utf-8')) as PersistedTask[]
      if (!Array.isArray(data)) return
      const terminalStates: TaskState[] = ['Completed', 'Failed', 'Cancelled', 'Unavailable']
      let dropped = 0
      for (const d of data) {
        if (!d || !d.id || !d.url) continue
        // Excluded items (permanently unavailable) are never restored as cards;
        // only the persisted playlist job item records the exclusion.
        if (d.state === 'Unavailable' || d.errorKind === 'permanent') continue
        // Startup queue cleanup: stale tasks without a real title ("Untitled",
        // "Unknown", empty), without a usable URL or with a placeholder item id
        // are invalid and must never reappear in Downloads / Queue. Only invalid
        // job records are removed — downloaded files on disk are never touched.
        if (isInvalidTitle(d.title) || typeof d.url !== 'string' || !d.url.trim()) {
          dropped += 1
          continue
        }
        if (d.playlistId && isPlaceholderItemId(d.playlistItemId)) {
          dropped += 1
          continue
        }
        const uniqueKey = d.uniqueKey || (d.playlistId && d.playlistItemId ? `${d.playlistId}:${d.playlistItemId}:${d.format}` : d.id)
        if (this.jobsByKey.has(uniqueKey)) {
          // Migration: Skip duplicates if they share the same uniqueKey. Keep the first (oldest/newest) we encounter.
          continue
        }
        const terminal = terminalStates.includes(d.state)
        const task: DownloadTask = {
          id: d.id,
          uniqueKey,
          title: d.title,
          url: d.url,
          kind: d.kind === 'audio' ? 'audio' : d.kind === 'image' ? 'image' : 'video',
          format: d.format,
          quality: d.quality,
          thumbnail: d.thumbnail,
          duration: d.duration,
          playlistId: d.playlistId,
          playlistTitle: d.playlistTitle,
          playlistUrl: d.playlistUrl,
          playlistIndex: d.playlistIndex,
          playlistCount: d.playlistCount,
          playlistItemId: d.playlistItemId,
          downloadFolder: d.downloadFolder,
          // A Paused task stays Paused on restart (never auto-starts); its
          // attemptDir is kept so Resume continues the SAME `.part` download.
          state: terminal || d.state === 'Paused' ? d.state : 'Waiting',
          progress: terminal || d.state === 'Paused'
            ? (d.progress ?? { percent: 0, downloadedBytes: 0, stage: 'queued' })
            : { percent: 0, downloadedBytes: 0, stage: 'queued', message: 'Queued — waiting to start' },
          error: terminal ? d.error : undefined,
          errorDetails: terminal ? d.errorDetails : undefined,
          errorKind: terminal ? d.errorKind : undefined,
          filePath: d.filePath,
          fileSize: d.fileSize,
          createdAt: d.createdAt,
          updatedAt: Date.now(),
          attempt: 0,
          attemptDir: d.attemptDir,
          retryAt: undefined,
          tempDir: tempDirFor(d.id),
          // Restored active tasks auto-start so the queue resumes immediately.
          autoStart: terminal || d.state === 'Paused' ? false : true
        }
        this.tasks.push(task)
        this.jobsByKey.set(uniqueKey, task)
        this.requests.set(task.id, {
          url: d.url,
          kind: task.kind,
          format: task.format,
          quality: task.quality,
          advanced: d.advanced,
          title: d.title,
          thumbnail: d.thumbnail,
          duration: d.duration,
          uploader: d.uploader,
          uploadDate: d.uploadDate,
          playlistId: d.playlistId,
          playlistTitle: d.playlistTitle,
          downloadFolder: d.downloadFolder
        })
        this.controls.set(task.id, { paused: false, cancelled: false })
        this.playlists.syncItemFromTask(task)
      }
      if (dropped > 0) {
        logger.info(`[VIDAUD][QUEUE] Startup cleanup: removed ${dropped} invalid restored task(s)`)
        this.persist()
      }
      logger.info(`restored ${this.tasks.length} task(s)`)
    } catch (e) {
      logger.error(`queue restore failed: ${e}`)
    }
  }

  // -------------------------------------------------------------------------
  // Event emission

  private emit(): void {
    const tasks = this.getQueue()
    const stats = this.getStats()
    const playlists = this.playlists.list()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send(IPC.events.queue, tasks)
        win.webContents.send(IPC.events.stats, stats)
        win.webContents.send(IPC.events.playlists, playlists)
      }
    }
  }
}
