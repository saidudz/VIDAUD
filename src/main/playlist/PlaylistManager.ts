import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AdvancedOptions, DownloadKind, DownloadRequest, ItemStatus, PlaylistItem, PlaylistJob, PlaylistStats } from '@shared/types'
import { hasRealTitle, isPlaceholderItemId } from '../utils/title'
import { logger } from '../utils/logger'

/**
 * Owns the persistent per-playlist jobs. Every playlist item — including ones
 * that completed or permanently failed — is retained here so the UI can always
 * show the real totals ("23 completed, 27 remaining"), across app restarts,
 * even after tasks are cleared from the live queue.
 */
export class PlaylistManager {
  private jobs: PlaylistJob[] = []
  private file: string
  private persistTimer: NodeJS.Timeout | null = null

  constructor() {
    const userData = app.getPath('userData')
    if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
    this.file = join(userData, 'playlist-jobs.json')
    this.restore()
  }

  /**
   * Returns the job for this playlist, creating or reusing it. When reusing an
   * existing job the items are merged (kept in playlist order) so re-adding a
   * playlist never loses previously recorded item states.
   */
  ensureJob(req: DownloadRequest, entries: DownloadRequest['entries'], folder: string | undefined): PlaylistJob {
    let job = this.jobs.find((j) => j.playlistId === req.playlistId && j.playlistUrl === req.playlistUrl)
    if (!job) {
      job = {
        playlistId: req.playlistId ?? '',
        playlistTitle: req.playlistTitle ?? req.title ?? 'Playlist',
        playlistUrl: req.playlistUrl ?? req.url,
        totalItems: req.playlistCount ?? entries?.length ?? 0,
        kind: req.kind,
        format: req.format,
        quality: req.quality,
        advanced: req.advanced,
        downloadFolder: folder,
        createdAt: Date.now(),
        items: []
      }
      this.jobs.push(job)
    } else {
      job.playlistTitle = req.playlistTitle ?? job.playlistTitle
      job.kind = req.kind
      job.format = req.format
      job.quality = req.quality
      job.advanced = req.advanced
      job.downloadFolder = folder ?? job.downloadFolder
      job.totalItems = Math.max(job.totalItems, req.playlistCount ?? entries?.length ?? 0)
    }
    this.persist()
    return job
  }

  /** Get (or lazily create) a job item entry. */
  getOrCreateItem(job: PlaylistJob, entry: { id: string; title: string; url: string; index?: number; duration?: number; thumbnail?: string; uploader?: string }): PlaylistItem {
    let item = job.items.find((i) => i.itemId === entry.id)
    if (!item) {
      item = {
        itemId: entry.id,
        uniqueKey: `${job.playlistId}:${entry.id}:${job.format}`,
        index: entry.index ?? job.items.length + 1,
        title: entry.title,
        url: entry.url,
        duration: entry.duration,
        thumbnail: entry.thumbnail,
        uploader: entry.uploader,
        status: 'Waiting',
        attempt: 0
      }
      job.items.push(item)
      // Keep items in playlist order.
      job.items.sort((a, b) => a.index - b.index)
    } else {
      if (entry.title) item.title = entry.title
      if (entry.thumbnail) item.thumbnail = entry.thumbnail
      if (entry.duration) item.duration = entry.duration
      if (entry.uploader) item.uploader = entry.uploader
      if (entry.url) item.url = entry.url
    }
    return item
  }

  updateItem(playlistId: string, itemId: string, patch: Partial<PlaylistItem>): PlaylistItem | undefined {
    const job = this.jobs.find((j) => j.playlistId === playlistId)
    if (!job) return undefined
    const item = job.items.find((i) => i.itemId === itemId)
    if (!item) return undefined
    Object.assign(item, patch)
    this.persistSoon()
    return item
  }

  /** Map a live task state onto the matching job item. */
  syncItemFromTask(task: { playlistId?: string; playlistItemId?: string; playlistIndex?: number; state: ItemStatus } & Partial<PlaylistItem>): void {
    if (!task.playlistId) return
    const job = this.jobs.find((j) => j.playlistId === task.playlistId)
    if (!job) return
    const item = job.items.find((i) => i.itemId === task.playlistItemId || i.index === task.playlistIndex)
    if (!item) return
    item.status = task.state
    item.taskId = (task as { id?: string }).id ?? item.taskId
    if (task.attempt !== undefined) item.attempt = task.attempt
    if (task.retryAt !== undefined) item.retryAt = task.retryAt
    if (task.error !== undefined) item.error = task.error
    if (task.errorDetails !== undefined) item.errorDetails = task.errorDetails
    if (task.errorKind !== undefined) item.errorKind = task.errorKind
    this.persistSoon()
  }

  getJob(playlistId: string): PlaylistJob | undefined {
    return this.jobs.find((j) => j.playlistId === playlistId)
  }

  list(): PlaylistJob[] {
    return this.jobs.map((j) => ({ ...j, items: [...j.items] }))
  }

  /**
   * Clear Completed on the Downloads list: remove every completed item from a
   * job's item list. Files on disk, the Completed library and History are never
   * touched. When a job has no items left it is dropped entirely so nothing
   * reappears on the Downloads page after a restart.
   */
  clearCompletedItems(playlistId: string): string[] {
    const job = this.jobs.find((j) => j.playlistId === playlistId)
    if (!job) return []
    const removed = job.items.filter((i) => i.status === 'Completed')
    if (removed.length === 0) return []
    job.items = job.items.filter((i) => i.status !== 'Completed')
    if (job.items.length === 0) {
      this.jobs = this.jobs.filter((j) => j.playlistId !== playlistId)
    }
    this.persist()
    return removed.map((i) => i.itemId)
  }

  /** Remove a job and its folder-link entirely (used by clearCompleted when a playlist is fully terminal). */
  removeJob(playlistId: string): void {
    this.jobs = this.jobs.filter((j) => j.playlistId !== playlistId)
    this.persist()
  }

  static computeStats(job: PlaylistJob): PlaylistStats {
    const s: PlaylistStats = { total: job.totalItems || job.items.length, queued: 0, analyzing: 0, downloading: 0, completed: 0, retrying: 0, failed: 0, unavailable: 0, cancelled: 0, finished: false }
    for (const item of job.items) {
      switch (item.status) {
        case 'Waiting':
        case 'Paused':
          s.queued += 1
          break
        case 'Analyzing':
          s.analyzing += 1
          break
        case 'Downloading':
        case 'Processing':
        case 'Converting':
          s.downloading += 1
          break
        case 'Completed':
          s.completed += 1
          break
        case 'Retrying':
          s.retrying += 1
          break
        case 'Failed':
          s.failed += 1
          break
        case 'Unavailable':
          s.unavailable += 1
          break
        case 'Cancelled':
          s.cancelled += 1
          break
      }
    }
    const terminal = s.completed + s.unavailable + s.cancelled
    s.finished = s.total > 0 && terminal === s.total && s.failed === 0
    return s
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.jobs), 'utf-8')
    } catch (e) {
      logger.error(`playlist jobs persist failed: ${e}`)
    }
  }

  /** Debounced persist: progress updates fire many times per second, but the
   *  jobs file only needs to be written a few times per second. */
  private persistSoon(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persist()
    }, 300)
  }

  private restore(): void {
    try {
      if (!existsSync(this.file)) return
      const data = JSON.parse(readFileSync(this.file, 'utf-8')) as PlaylistJob[]
      if (!Array.isArray(data)) return
      this.jobs = data
        .filter((j) => j && typeof j.playlistId === 'string' && Array.isArray(j.items))
        .map((j) => {
          // Drop persisted items that should have been excluded from the start
          // (no real title, no URL, or a placeholder id) as well as items that
          // were permanently excluded (unavailable/removed). They must never
          // reappear in the Downloads page. The shared title check also catches
          // number-prefixed placeholders like "21 - Untitled".
          const items = j.items.filter((i) => {
            if (i.status === 'Unavailable' || i.errorKind === 'permanent') return false
            if (!hasRealTitle(i.title)) return false
            if (typeof i.url !== 'string' || i.url.trim().length === 0) return false
            if (isPlaceholderItemId(i.itemId)) return false
            return true
          })
          return {
            ...j,
            kind: j.kind === 'audio' ? 'audio' : j.kind === 'image' ? 'image' : 'video',
            totalItems: items.length,
            items: items.map((i) => ({ ...i, uniqueKey: i.uniqueKey || `${j.playlistId}:${i.itemId}:${j.format}`, status: i.status || 'Waiting', attempt: i.attempt || 0 }))
          }
        })
      logger.info(`restored ${this.jobs.length} playlist job(s)`)
    } catch (e) {
      logger.error(`playlist jobs restore failed: ${e}`)
    }
  }
}

export type { AdvancedOptions, DownloadKind, ItemStatus }
