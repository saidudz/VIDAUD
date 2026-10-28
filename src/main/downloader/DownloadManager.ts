import { existsSync, readdirSync, renameSync, copyFileSync, rmSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AdvancedOptions, AppSettings, DownloadRequest, DownloadTask, ErrorKind, StreamProgress, TaskPhase, DownloadProgressPayload } from '@shared/types'
import { getFormat, type FormatDefinition } from '@shared/formats'
import { downloadStream, cleanupDir, fetchSingleInfo, resolveStreamUrl, YOUTUBE_PLAYER_CLIENTS, YOUTUBE_COMBINED_FALLBACK_CLIENTS, type DownloadControl } from './ytdlp'
import { verifyMediaUrl, sniffFileType, sanitizeUrl, isNonMediaContentType, type HttpResponseInfo } from './httpCheck'
import { classifyError, isAudioUnavailableError, DownloadFailure, AudioFailure } from './errors'
import { streamImageToDisk, validateImageFile, deriveImageFilename, ImageFailure } from './image'
import { isImageFormatId } from '@shared/formats'
import { FfmpegManager, FfmpegError, type FfprobeResult, type ConvertOptions } from '../ffmpeg/FfmpegManager'
import { CompatibilityManager, type SourceStreamInfo } from '../formats/CompatibilityManager'
import { FormatManager } from '../formats/FormatManager'
import { normalizeEncoder } from '../formats/codecs'
import { resolveFinalPath, fileExists, fileSizeBytes, sanitizeFilename, minimalSafeName } from '../utils/files'
import { logger } from '../utils/logger'

export interface RunnerDeps {
  settings: () => AppSettings
  control: DownloadControl
  onUpdate: (t: DownloadTask) => void
  onProgress: (p: DownloadProgressPayload) => void
  onCompleted: (t: DownloadTask, path: string, size: number, skip: boolean) => void
  onFailed: (t: DownloadTask, message: string, details: string) => void
  acquireDownload: () => Promise<boolean>
  releaseDownload: () => void
  acquireProcessing: () => Promise<boolean>
  releaseProcessing: () => void
  isAborted: () => boolean
}

export interface RunnerResult {
  state: 'completed' | 'failed' | 'paused' | 'cancelled'
  error?: string
  errorDetails?: string
  errorKind?: ErrorKind
}

/**
 * The concrete audio stream chosen during analysis for an audio-kind job.
 * `formatId` is the best audio-only stream; `fallbackFormatId` is the best
 * combined (video+audio) stream used only when the audio-only download fails
 * AND the fallback is confirmed to contain real audio by FFprobe.
 */
interface AudioStreamSelection {
  formatId?: string
  fallbackFormatId?: string
  hasAudio: boolean
}

/** User-facing message for a download that could not be validated as audio. */
const AUDIO_FILE_INVALID_MSG = 'Audio download could not be validated.\n\nThe downloaded response did not contain a valid audio stream.'

/** Formats diagnostic key/value pairs into the errorDetails string. */
function diagLines(lines: Array<[string, string | number | null | undefined]>): string {
  return lines
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

/** Reads up to `n` leading bytes of a file (used for magic-byte sniffing). */
function readFirstBytes(file: string, n: number): Buffer {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(n)
      const read = readSync(fd, buf, 0, n, 0)
      return buf.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  } catch {
    return Buffer.alloc(0)
  }
}

/** Builds the HTTP diagnostic block for errorDetails. */
function formatHttpDiag(info: HttpResponseInfo): string {
  return diagLines([
    ['HTTP Status', info.status],
    ['Content-Type', info.contentType ?? 'unknown'],
    ['Content-Length', info.contentLength],
    ['Final URL', info.finalUrl],
    ['Redirects', info.redirects]
  ])
}

function isPlaceholderTitle(title: string): boolean {
  const t = (title || '').trim()
  // Handles "Untitled", "Item 21" and numbered forms like "01 - Untitled".
  const stripped = t.replace(/^\d+\s*[-–.\s]+/, '').trim()
  return /^Untitled/i.test(stripped) || /^Item\s*\d+/i.test(stripped) || /^Untitled/i.test(t)
}

// ---------------------------------------------------------------------------
// Real unified progress tracker
//
// Video (video + audio):    video 0-70, audio 70-90, merge 90-98, validation 98-100
// Audio (audio only):       download 0-85, convert 85-97, validation 97-100
//
// Percent is derived from real bytes (downloadedBytes / totalBytes) during the
// download phases, from real FFmpeg timestamps during processing, and is null
// (indeterminate) whenever the total size is unknown.
// ---------------------------------------------------------------------------

interface StreamState {
  downloaded: number
  total?: number
  done: boolean
}

class ProgressTracker {
  private id: string
  private isAudioKind: boolean
  private phase: TaskPhase = 'video'
  private video: StreamState = { downloaded: 0, done: false }
  private audio: StreamState = { downloaded: 0, done: false }
  private emit: (p: DownloadProgressPayload) => void
  private speed = 0
  private lastSample = { t: 0, bytes: 0 }
  private phasePercent: number | null = null
  private lastSent = 0

  constructor(id: string, kind: 'video' | 'audio', emit: (p: DownloadProgressPayload) => void) {
    this.id = id
    this.isAudioKind = kind === 'audio'
    this.emit = emit
    this.phase = this.isAudioKind ? 'download' : 'video'
  }

  /** Feed a real progress sample from a single stream (video or audio). */
  onStream(stream: 'video' | 'audio', p: StreamProgress): void {
    const s = stream === 'video' ? this.video : this.audio
    if (p.downloadedBytes >= 0) s.downloaded = Math.max(s.downloaded, p.downloadedBytes)
    if (p.totalBytes && p.totalBytes > 0) s.total = Math.max(s.total ?? 0, p.totalBytes)
    if ((p.totalBytes && s.downloaded >= p.totalBytes) || (p.percent !== undefined && p.percent >= 100)) s.done = true
    this.push()
  }

  /**
   * Seed the tracker with bytes already on disk (yt-dlp `.part` / fragment
   * files left by a paused or interrupted attempt). Percent then continues
   * from the pre-pause value instead of resetting to 0.
   */
  seed(stream: 'video' | 'audio', bytes: number): void {
    if (bytes <= 0) return
    const s = stream === 'video' ? this.video : this.audio
    if (bytes > s.downloaded) s.downloaded = bytes
    this.push()
  }

  markDone(stream: 'video' | 'audio'): void {
    if (stream === 'video') this.video.done = true
    else this.audio.done = true
    this.push()
  }

  /** Switch to a processing phase; percent is real ffmpeg progress (or null). */
  setPhase(phase: TaskPhase, percent: number | null = null): void {
    this.phase = phase
    this.phasePercent = percent
    this.push()
  }

  private totalDownloaded(): number {
    return this.video.downloaded + this.audio.downloaded
  }

  private totalBytes(): number {
    return (this.video.total ?? 0) + (this.audio.total ?? 0)
  }

  private computeDownloadPercent(): number | null {
    if (this.isAudioKind) {
      const a = this.audio
      if (a.done) return 85
      if (a.total && a.total > 0) return Math.min(84, Math.max(0, (a.downloaded / a.total) * 85))
      return null // unknown total -> indeterminate
    }
    // Video: both streams share the 0-90 band, weighted by real bytes.
    const total = this.totalBytes()
    const done =
      (this.video.done || (this.video.total ? this.video.downloaded >= this.video.total : false)) &&
      (this.audio.done || (this.audio.total ? this.audio.downloaded >= this.audio.total : false))
    if (done) return 90
    if (total > 0) return Math.min(89, Math.max(0, (this.totalDownloaded() / total) * 90))
    return null
  }

  private currentPercent(): number | null {
    if (this.phase === 'merge' || this.phase === 'remux' || this.phase === 'converting' || this.phase === 'validation') {
      return this.phasePercent
    }
    return this.computeDownloadPercent()
  }

  private computeSpeed(): void {
    const now = Date.now()
    const bytes = this.totalDownloaded()
    const dt = now - this.lastSample.t
    if (this.lastSample.t > 0 && dt > 0) {
      const inst = ((bytes - this.lastSample.bytes) / dt) * 1000
      if (inst >= 0 && Number.isFinite(inst)) {
        this.speed = this.speed > 0 ? this.speed * 0.6 + inst * 0.4 : inst
      }
    }
    this.lastSample = { t: now, bytes }
  }

  private push(): void {
    this.computeSpeed()
    const percent = this.currentPercent()
    const total = this.totalBytes()
    const downloaded = this.totalDownloaded()
    let eta: number | null = null
    if (this.speed > 0 && total > 0 && total > downloaded) {
      eta = (total - downloaded) / this.speed
    }
    const now = Date.now()
    if (now - this.lastSent < 120) return
    this.lastSent = now
    this.emit({
      id: this.id,
      phase: this.phase,
      downloadedBytes: downloaded,
      totalBytes: total > 0 ? total : null,
      percent,
      speed: Math.round(this.speed),
      eta
    })
  }
}

const IMAGE_EXT = /\.(webp|jpg|jpeg|png)$/i

/**
 * Finds a downloaded media file in `dir` that starts with `prefix`. NEVER
 * returns an image (thumbnail) file or a partial download — a `.webp` cover
 * must never be mistaken for the audio input.
 */
function streamFile(dir: string, prefix: string): string | null {
  try {
    const f = readdirSync(dir).find((n) => {
      if (!n.startsWith(prefix)) return false
      if (n.endsWith('.part') || n.endsWith('.ytdl')) return false
      if (IMAGE_EXT.test(n)) return false
      try {
        return statSync(join(dir, n)).size > 0
      } catch {
        return false
      }
    })
    return f ? join(dir, f) : null
  } catch {
    return null
  }
}

function imageFile(dir: string): string | null {
  try {
    const f = readdirSync(dir).find((n) => /\.(jpg|jpeg|png|webp)$/i.test(n))
    return f ? join(dir, f) : null
  } catch {
    return null
  }
}

/**
 * Sums the bytes already on disk for a yt-dlp stream prefix: the `.part`
 * accumulator and any `-FragN` fragment files a paused or interrupted attempt
 * left behind. Used to seed the progress tracker on a resume so the percent
 * continues from the pre-pause value instead of resetting to 0.
 */
function partialBytes(dir: string, prefix: string): number {
  try {
    let total = 0
    for (const n of readdirSync(dir)) {
      if (!n.startsWith(prefix)) continue
      if (!n.endsWith('.part') && !/\.part-Frag/i.test(n)) continue
      try {
        total += statSync(join(dir, n)).size
      } catch {
        /* ignore */
      }
    }
    return total
  } catch {
    return 0
  }
}

function buildMetadata(req: DownloadRequest, task: DownloadTask): Record<string, string> {
  const md: Record<string, string> = { title: req.title ?? task.title ?? '' }
  if (req.uploader) md.artist = req.uploader
  if (req.playlistTitle) md.album = req.playlistTitle
  if (task.playlistIndex) md.track = String(task.playlistIndex)
  if (req.uploadDate) md.date = String(req.uploadDate).slice(0, 4)
  return md
}

const PHASE_MESSAGE: Record<TaskPhase, string> = {
  queued: 'Queued',
  analyzing: 'Fetching media info',
  video: 'Downloading video stream',
  audio: 'Downloading audio stream',
  download: 'Downloading audio',
  merge: 'Merging video and audio streams',
  remux: 'Finalizing video',
  converting: 'Converting with FFmpeg',
  validation: 'Validating file',
  retry: 'Retrying',
  paused: 'Paused',
  done: 'Done'
}

export class DownloadManager {
  private ffmpeg = new FfmpegManager()

  private makeTracker(task: DownloadTask, kind: 'video' | 'audio', deps: RunnerDeps): ProgressTracker {
    return new ProgressTracker(task.id, kind, (p) => {
      const progress = {
        percent: p.percent ?? 0,
        indeterminate: p.percent == null,
        speedBytes: p.speed > 0 ? p.speed : undefined,
        downloadedBytes: p.downloadedBytes,
        totalBytes: p.totalBytes ?? undefined,
        etaSeconds: p.eta ?? undefined,
        phase: p.phase,
        stage: p.phase,
        message: PHASE_MESSAGE[p.phase] ?? ''
      }
      deps.onUpdate({ ...task, state: 'Downloading', progress })
      deps.onProgress(p)
    })
  }

  private targetFormat(req: DownloadRequest): FormatDefinition {
    const target = getFormat(req.format)
    if (!target) throw new Error(`Unknown output format "${req.format}".`)
    return target
  }

  async runTask(task: DownloadTask, req: DownloadRequest, deps: RunnerDeps): Promise<RunnerResult> {
    const settings = deps.settings()
    // Image kind bypasses the video/audio FFmpeg pipeline entirely: original
    // bytes are streamed to disk, validated by signature, and saved as-is.
    if (req.kind === 'image' || task.kind === 'image') {
      return this.runImageTask(task, req, deps)
    }
    const target = this.targetFormat(req)
    const folder = task.downloadFolder || settings.downloadFolder
    const isPlaylist = !!task.playlistId
    const sanitize = isPlaylist ? settings.sanitizeFilenames : true
    // A RESUME reuses the attempt dir a paused attempt left behind: its `.part`
    // / fragment files let yt-dlp continue at the byte level (HTTP Range resume)
    // and its finished streams are reused as-is. A fresh attempt (first run or
    // retry) always gets its OWN directory so a failed attempt's input file can
    // never be reused by a Retry (spec: fresh attemptId, fresh temp dir, fresh
    // input path). QueueManager clears `attemptDir` on retry/terminal; the
    // `existsSync` guard below is the belt-and-suspenders check.
    const reuseDir = task.attemptDir && existsSync(task.attemptDir) ? task.attemptDir : undefined
    let tmpDir: string
    if (reuseDir) {
      tmpDir = reuseDir
      logger.info(`[VIDAUD] Resume: reusing attempt dir ${tmpDir}`)
    } else {
      const attemptId = randomUUID()
      tmpDir = join(task.tempDir, `a${task.attempt}-${attemptId.slice(0, 6)}`)
      task.attemptDir = tmpDir
      logger.info(`[VIDAUD] Fresh attempt dir: ${tmpDir}`)
    }

    const makeBaseName = (title: string): string => {
      return sanitize ? sanitizeFilename(title, 'download') : minimalSafeName(title, 'download')
    }
    // Filename source is always the real title. playlistIndex stays metadata/UI
    // only; it is prepended to the FILENAME solely when the user explicitly
    // opts into numbered filenames (playlistIndexInFilename=true).
    const filenameFor = (title: string): string => {
      const base = makeBaseName(title).replace(/\.[a-z0-9]+$/i, '')
      const numbered = isPlaylist && task.playlistIndex && settings.playlistIndexInFilename ? `${String(task.playlistIndex).padStart(2, '0')} - ${base}` : base
      return `${numbered}.${target.extension}`
    }
    let finalPath = resolveFinalPath(folder, filenameFor(task.title), { action: settings.onExistingFile }, sanitize)

    // Skip if file already exists and user chose "skip"
    if (settings.onExistingFile === 'skip' && fileExists(finalPath.path)) {
      deps.onUpdate({ ...task, state: 'Completed', progress: { ...task.progress, percent: 100, stage: 'done', message: 'File already exists' }, filePath: finalPath.path, fileSize: fileSizeBytes(finalPath.path) })
      deps.onCompleted(task, finalPath.path, fileSizeBytes(finalPath.path), true)
      return { state: 'completed' }
    }

    try {
      // ------------------------------------------------------------------
      // Analyzing phase.
      //
      // Audio kind ("MP3"): every item is analyzed independently before its
      // download, because we must not assume an item has an audio stream.
      // Items without audio are re-analyzed exactly once with fresh stream
      // info; if the fresh analysis still finds none, the item is terminal
      // ("No compatible audio stream is available for this item.").
      // Analysis failures are classified: permanent ones (copyright/region/
      // private/removed/invalid) mark the item Unavailable immediately,
      // transient ones (timeouts/network) are retried.
      //
      // Video kind: only playlist placeholders ("Item 21") and retries are
      // analyzed, to recover real titles + fresh stream URLs.
      // ------------------------------------------------------------------
      const isRetry = task.attempt > 1
      const needsAnalysis = req.kind === 'audio' || (isPlaylist && (isPlaceholderTitle(task.title) || isRetry))
      let audioSelection: AudioStreamSelection | undefined
      if (needsAnalysis) {
        deps.onUpdate({ ...task, state: 'Analyzing', progress: { ...task.progress, percent: 0, indeterminate: true, downloadedBytes: 0, stage: 'analyzing', phase: 'analyzing', message: isRetry ? 'Re-analyzing media...' : 'Fetching media info...' } })
        let meta: Awaited<ReturnType<typeof fetchSingleInfo>> | undefined
        try {
          meta = await fetchSingleInfo(req.url, undefined)
        } catch (e) {
          if (req.kind === 'audio') {
            const c = classifyError(e)
            cleanupDir(tmpDir)
            if (c.kind === 'permanent') {
              return { state: 'failed', error: c.message, errorKind: 'permanent', errorDetails: this.errorDetails(e) }
            }
            const msg = /timed out|timeout/i.test(c.raw) ? 'Analysis timed out. Retrying...' : c.message
            return { state: 'failed', error: msg, errorKind: 'temporary', errorDetails: this.errorDetails(e) }
          }
          if (isRetry) {
            // A retry must not proceed with a stale stream URL: re-analyze
            // with fresh metadata instead (per the spec). Permanent blocks
            // (private/removed) mark the item Unavailable, transient ones
            // (timeout/metadata/expired URL) are retried again.
            const c = classifyError(e)
            cleanupDir(tmpDir)
            if (c.kind === 'permanent') {
              return { state: 'failed', error: c.message, errorKind: 'permanent', errorDetails: this.errorDetails(e) }
            }
            const msg = /timed out|timeout/i.test(c.raw) ? 'Analysis timed out. Retrying...' : c.message
            return { state: 'failed', error: msg, errorKind: 'temporary', errorDetails: this.errorDetails(e) }
          }
          logger.warn(`[VIDAUD] per-item metadata refresh failed: ${e}`)
          // First attempt: even if the metadata refresh failed we keep the item.
        }
        if (meta) {
          if (meta.title && (isPlaceholderTitle(task.title) || isRetry)) {
            task.title = meta.title
            finalPath = resolveFinalPath(folder, filenameFor(task.title), { action: settings.onExistingFile }, sanitize)
          }
          if (meta.thumbnail) task.thumbnail = meta.thumbnail
          if (meta.duration) task.duration = meta.duration
          if (meta.uploader) req.uploader = meta.uploader

          if (req.kind === 'audio') {
            // Record the exact stream to download: best audio-only first, with
            // a combined-with-audio fallback. FFmpeg must NOT start until a
            // real audio stream is confirmed in the downloaded file.
            audioSelection = {
              formatId: meta.bestAudio?.formatId,
              fallbackFormatId: meta.bestAudioFallback?.formatId,
              hasAudio: meta.hasAudio
            }
            logger.info(
              `[VIDAUD] Audio stream selected: ${meta.bestAudio?.formatId ?? 'none'} (${meta.bestAudio?.acodec ?? 'n/a'} @ ${meta.bestAudio?.abr ?? meta.bestAudio?.tbr ?? '?'}k), fallback: ${meta.bestAudioFallback?.formatId ?? 'none'}`
            )
          }

          if (req.kind === 'audio' && !meta.hasAudio) {
            cleanupDir(tmpDir)
            const maxAudioAttempts = 1 + Math.max(0, settings.retryCount)
            if (task.attempt >= maxAudioAttempts) {
              return { state: 'failed', error: 'No audio stream is available for this item.', errorKind: 'permanent', errorDetails: '[AUDIO_STREAM_NOT_FOUND] No audio stream was found during analysis.' }
            }
            return { state: 'failed', error: 'Audio stream unavailable. Re-analyzing...', errorKind: 'temporary', errorDetails: '[AUDIO_STREAM_NOT_FOUND] No audio stream detected during analysis.' }
          }
          if (req.kind === 'audio' && isRetry) {
            deps.onUpdate({ ...task, state: 'Analyzing', progress: { ...task.progress, percent: 0, indeterminate: true, downloadedBytes: 0, stage: 'analyzing', phase: 'analyzing', message: 'Audio stream found. Retrying download...' } })
          }
        }
      }

      if (!(await deps.acquireDownload())) {
        if (deps.control.cancelled) {
          cleanupDir(tmpDir)
          return { state: 'cancelled' }
        }
        return { state: 'paused' }
      }

      task.state = 'Downloading'
      task.error = undefined
      task.errorDetails = undefined
      deps.onUpdate({ ...task, progress: { ...task.progress, percent: 0, indeterminate: false, downloadedBytes: 0, totalBytes: undefined, stage: 'download', phase: 'download' } })

      let lastError = ''
      let lastDetails = ''
      const tDownload = Date.now()
      logger.info(`[VIDAUD] Download started: ${req.url} (format=${req.format}, kind=${req.kind}, attempt=${task.attempt})`)
      let ok = false
      try {
        ok = await this.performDownload(task, req, tmpDir, deps, audioSelection)
      } catch (e) {
        const c = classifyError(e)
        lastError = c.message
        lastDetails = this.errorDetails(e)
        logger.error(`download failed: ${lastDetails}`)
      } finally {
        deps.releaseDownload()
        logger.info(`[VIDAUD] Download phase took ${((Date.now() - tDownload) / 1000).toFixed(1)} s`)
      }

      if (deps.control.cancelled) {
        cleanupDir(tmpDir)
        return { state: 'cancelled' }
      }
      if (deps.control.paused) {
        return { state: 'paused' }
      }
      if (!ok) {
        const classified = classifyError(lastError, lastDetails)
        cleanupDir(tmpDir)
        const noAudioText = `${lastError}\n${lastDetails}`
        if (req.kind === 'audio' && classified.kind !== 'permanent' && (isAudioUnavailableError(noAudioText) || /AUDIO_STREAM_NOT_FOUND|AUDIO_FILE_INVALID|AUDIO_DOWNLOAD_INVALID|AUDIO_FILE_EMPTY|FFPROBE_FAILED/.test(lastDetails))) {
          // Respect the configured retry budget: the item is re-analyzed with a
          // fresh stream URL on every attempt (streams expire / are transient).
          // Only after the budget is exhausted is it marked as permanently
          // having no usable audio stream.
          const maxAudioAttempts = 1 + Math.max(0, settings.retryCount)
          if (task.attempt >= maxAudioAttempts) {
            return { state: 'failed', error: 'No audio stream is available for this item.', errorKind: 'permanent', errorDetails: lastDetails }
          }
          return { state: 'failed', error: 'Audio stream unavailable. Re-analyzing...', errorKind: 'temporary', errorDetails: lastDetails }
        }
        return { state: 'failed', error: classified.message, errorKind: classified.kind, errorDetails: lastDetails }
      }

      // ------------------------------------------------------------------
      // Processing (merge / remux / convert)
      // ------------------------------------------------------------------
      deps.onUpdate({ ...task, state: 'Converting', progress: { ...task.progress, percent: 0, stage: 'processing', message: 'Processing with FFmpeg' } })
      if (!(await deps.acquireProcessing())) {
        if (deps.control.cancelled) {
          cleanupDir(tmpDir)
          return { state: 'cancelled' }
        }
        return { state: 'paused' }
      }
      let processed: string | null = null
      let processingError: string | null = null
      const tProcess = Date.now()
      try {
        processed = await this.performProcessing(task, req, target, tmpDir, deps)
      } catch (e) {
        const c = classifyError(e)
        processingError = c.message
        lastDetails = this.errorDetails(e)
        logger.error(`processing failed: ${lastDetails}`)
      } finally {
        deps.releaseProcessing()
      }
      logger.info(`[VIDAUD] Processing took ${((Date.now() - tProcess) / 1000).toFixed(1)} s`)

      if (deps.control.cancelled) {
        cleanupDir(tmpDir)
        return { state: 'cancelled' }
      }
      if (deps.control.paused) {
        return { state: 'paused' }
      }
      if (!processed) {
        const c = classifyError(processingError || 'Conversion failed', lastDetails)
        cleanupDir(tmpDir)
        return { state: 'failed', error: c.message || 'Conversion failed', errorKind: c.kind, errorDetails: lastDetails }
      }

      // ------------------------------------------------------------------
      // Validation
      // ------------------------------------------------------------------
      const bandEnd = req.kind === 'video' ? 98 : 97
      deps.onUpdate({ ...task, state: 'Processing', progress: { ...task.progress, percent: bandEnd, stage: 'validation', phase: 'validation', message: 'Validating file' } })
      const valid = await this.validateOutput(processed, target)
      if (!valid.ok) {
        cleanupDir(tmpDir)
        const c = classifyError(valid.error)
        const code = req.kind === 'audio' ? `[${AudioFailure.MP3_VALIDATION_FAILED}] ` : ''
        return { state: 'failed', error: c.message || valid.error, errorKind: c.kind, errorDetails: `${code}Output validation failed: ${valid.error}` }
      }

      // ------------------------------------------------------------------
      // Move to final destination
      // ------------------------------------------------------------------
      finalPath = resolveFinalPath(folder, filenameFor(task.title), { action: settings.onExistingFile }, sanitize)
      try {
        if (!existsSync(folder)) {
          const { mkdirSync } = await import('node:fs')
          mkdirSync(folder, { recursive: true })
        }
        await this.moveFile(processed, finalPath.path)
        const size = fileSizeBytes(finalPath.path)
        cleanupDir(tmpDir)
        deps.onUpdate({ ...task, state: 'Completed', progress: { ...task.progress, percent: 100, indeterminate: false, stage: 'done', phase: 'done', message: 'Completed' }, filePath: finalPath.path, fileSize: size })
        deps.onCompleted(task, finalPath.path, size, false)
        return { state: 'completed' }
      } catch (e) {
        const c = classifyError(e)
        cleanupDir(tmpDir)
        return { state: 'failed', error: c.message, errorKind: c.kind, errorDetails: this.errorDetails(e) }
      }
    } catch (e) {
      const c = classifyError(e)
      cleanupDir(tmpDir)
      return { state: 'failed', error: c.message, errorKind: c.kind, errorDetails: this.errorDetails(e) }
    }
  }

  // -------------------------------------------------------------------------
  // Image download pipeline (unified queue, no FFmpeg, original bytes preserved)
  //
  // Image URL -> HTTP request -> validate response -> validate Content-Type
  // -> stream to disk -> detect format -> validate image -> save final file.
  // Streaming is used throughout; progress is real bytes (percent only when
  // the total size is known — never fake percentages).

  private async runImageTask(task: DownloadTask, req: DownloadRequest, deps: RunnerDeps): Promise<RunnerResult> {
    const settings = deps.settings()
    const folder = task.downloadFolder || settings.downloadFolder
    const sanitize = settings.sanitizeFilenames !== false
    const reuseDir = task.attemptDir && existsSync(task.attemptDir) ? task.attemptDir : undefined
    let tmpDir: string
    if (reuseDir) {
      tmpDir = reuseDir
      logger.info(`[VIDAUD][IMAGE] Resume: reusing attempt dir ${tmpDir}`)
    } else {
      const attemptId = randomUUID()
      tmpDir = join(task.tempDir, `a${task.attempt}-${attemptId.slice(0, 6)}`)
      task.attemptDir = tmpDir
      logger.info(`[VIDAUD][IMAGE] Fresh attempt dir: ${tmpDir}`)
    }
    try {
      mkdirSync(tmpDir, { recursive: true })
    } catch {
      /* ignore */
    }

    const guessExt = isImageFormatId(req.format) ? (req.format.toLowerCase() === 'jpeg' ? 'jpg' : req.format.toLowerCase() === 'tif' ? 'tiff' : req.format.toLowerCase()) : 'jpg'
    const makeBaseName = (title: string): string => {
      return sanitize ? sanitizeFilename(title, 'download') : minimalSafeName(title, 'download')
    }
    const stripExt = (t: string): string => t.replace(/\.[a-z0-9]+$/i, '')
    // Task titles for images are bare names (no extension); strip defensively.
    const baseTitle = stripExt(task.title || req.title || 'image')
    let finalPath = resolveFinalPath(folder, `${makeBaseName(baseTitle)}.${guessExt}`, { action: settings.onExistingFile }, sanitize)

    if (settings.onExistingFile === 'skip' && fileExists(finalPath.path)) {
      deps.onUpdate({ ...task, state: 'Completed', progress: { ...task.progress, percent: 100, stage: 'done', message: 'File already exists' }, filePath: finalPath.path, fileSize: fileSizeBytes(finalPath.path) })
      deps.onCompleted(task, finalPath.path, fileSizeBytes(finalPath.path), true)
      return { state: 'completed' }
    }

    if (!(await deps.acquireDownload())) {
      if (deps.control.cancelled) {
        cleanupDir(tmpDir)
        return { state: 'cancelled' }
      }
      return { state: 'paused' }
    }

    task.state = 'Downloading'
    task.error = undefined
    task.errorDetails = undefined
    const emitImageProgress = (downloaded: number, total: number | null): void => {
      const percent = total && total > 0 ? Math.min(99, Math.max(0, (downloaded / total) * 100)) : 0
      const indeterminate = !(total && total > 0)
      deps.onUpdate({
        ...task,
        state: 'Downloading',
        progress: {
          percent,
          indeterminate,
          speedBytes: undefined,
          downloadedBytes: downloaded,
          totalBytes: total ?? undefined,
          etaSeconds: undefined,
          phase: 'download',
          stage: 'download',
          message: indeterminate ? 'Downloading...' : 'Downloading'
        }
      })
      deps.onProgress({ id: task.id, phase: 'download', downloadedBytes: downloaded, totalBytes: total, percent: indeterminate ? null : Math.round(percent), speed: 0, eta: null })
    }
    deps.onUpdate({ ...task, progress: { ...task.progress, percent: 0, indeterminate: true, downloadedBytes: 0, totalBytes: undefined, stage: 'download', phase: 'download', message: 'Downloading...' } })
    logger.info(`[VIDAUD][IMAGE] Download started: ${req.url} (attempt=${task.attempt})`)

    const tmpFile = join(tmpDir, 'image.tmp')
    let dlInfo: Awaited<ReturnType<typeof streamImageToDisk>> | null = null

    // Try original URL first, then fall back to thumbnail if original fails permanently
    const originalUrl = req.url
    const thumbnailUrl = task.thumbnail && task.thumbnail !== req.url ? task.thumbnail : null
    const urlsToTry = thumbnailUrl ? [originalUrl, thumbnailUrl] : [originalUrl]

    for (let urlIndex = 0; urlIndex < urlsToTry.length; urlIndex++) {
      const currentUrl = urlsToTry[urlIndex]
      const isFallback = urlIndex > 0
      if (isFallback) {
        logger.info(`[VIDAUD][IMAGE] Original URL failed, trying thumbnail: ${currentUrl}`)
      }
      try {
        dlInfo = await streamImageToDisk(currentUrl, tmpFile, {
          onProgress: emitImageProgress,
          isAborted: () => ({ paused: deps.control.paused, cancelled: deps.control.cancelled })
        })
        // Success - break out of the fallback loop
        break
      } catch (e) {
        deps.releaseDownload()
        if (deps.control.cancelled) {
          cleanupDir(tmpDir)
          return { state: 'cancelled' }
        }
        if (deps.control.paused) {
          return { state: 'paused' }
        }
        const code = e instanceof DownloadFailure ? e.code : ''
        const details = this.errorDetails(e)
        logger.error(`[VIDAUD][IMAGE] download failed (${isFallback ? 'fallback' : 'original'}): ${details}`)
        // If this was the last URL to try, or the error is not a permanent HTTP error, fail
        const isLastAttempt = urlIndex === urlsToTry.length - 1
        const isPermanentHttpError = code === ImageFailure.IMAGE_HTTP_ERROR || code === ImageFailure.IMAGE_DOWNLOAD_INVALID || code === ImageFailure.IMAGE_FILE_INVALID
        if (isLastAttempt || !isPermanentHttpError) {
          cleanupDir(tmpDir)
          if (code === ImageFailure.IMAGE_DOWNLOAD_INVALID || code === ImageFailure.IMAGE_FILE_INVALID) {
            const msg = e instanceof Error ? e.message : 'The link did not return a supported image.'
            return { state: 'failed', error: msg, errorKind: 'permanent', errorDetails: details }
          }
          const c = classifyError(e, details)
          return { state: 'failed', error: c.message, errorKind: c.kind, errorDetails: details }
        }
        // Otherwise, continue to the next fallback URL
        // Re-acquire download slot for the next attempt
        if (!(await deps.acquireDownload())) {
          if (deps.control.cancelled) {
            cleanupDir(tmpDir)
            return { state: 'cancelled' }
          }
          return { state: 'paused' }
        }
        task.state = 'Downloading'
        task.error = undefined
        task.errorDetails = undefined
        deps.onUpdate({ ...task, progress: { ...task.progress, percent: 0, indeterminate: true, downloadedBytes: 0, totalBytes: undefined, stage: 'download', phase: 'download', message: isFallback ? 'Downloading thumbnail...' : 'Downloading...' } })
        logger.info(`[VIDAUD][IMAGE] Retrying with fallback URL: ${urlsToTry[urlIndex + 1]}`)
      }
    }

    deps.releaseDownload()

    if (deps.control.cancelled) {
      cleanupDir(tmpDir)
      return { state: 'cancelled' }
    }
    if (deps.control.paused) {
      return { state: 'paused' }
    }
    if (!dlInfo) {
      cleanupDir(tmpDir)
      return { state: 'failed', error: 'Image download produced no file.', errorKind: 'temporary', errorDetails: '[IMAGE_DOWNLOAD_FAILED] No download info returned.' }
    }

    // Validation phase (same queue states: Downloading -> Validating -> Completed).
    deps.onUpdate({ ...task, state: 'Processing', progress: { ...task.progress, percent: 98, stage: 'validation', phase: 'validation', message: 'Validating image' } })
    const v = validateImageFile(tmpFile, { contentType: dlInfo.contentType })
    if (!v.ok) {
      cleanupDir(tmpDir)
      const code = (v.details ?? '').match(/\[([A-Z_]+)\]/)?.[1] ?? ImageFailure.IMAGE_FILE_INVALID
      const permanent = code === ImageFailure.IMAGE_DOWNLOAD_INVALID || code === ImageFailure.IMAGE_FILE_INVALID
      const c = permanent ? { kind: 'permanent' as const, message: v.error ?? 'Downloaded file is not a valid image.' } : classifyError(v.error ?? 'Validation failed', v.details ?? '')
      return { state: 'failed', error: c.message, errorKind: c.kind, errorDetails: v.details ?? v.error ?? 'Validation failed' }
    }
    const realExt = v.ext ?? guessExt
    const realSize = v.size ?? dlInfo.bytes

    // Final filename: server filename wins when present, else the analyzed
    // title; never "Untitled" — deriveImageFilename falls back to a stable
    // hash name based on the URL.
    let outName: string
    try {
      const derived = deriveImageFilename(dlInfo.finalUrl, { contentDisposition: dlInfo.serverFilename, contentType: dlInfo.contentType, magicExt: realExt })
      const serverBase = dlInfo.serverFilename ? stripExt(derived.filename.replace(/\.[a-z0-9]+$/i, '')) : null
      const wantBase = serverBase && serverBase.toLowerCase() !== 'untitled' && serverBase.toLowerCase() !== 'unknown' ? serverBase : baseTitle
      const cleanBase = makeBaseName(wantBase).replace(/\.[a-z0-9]+$/i, '')
      const fallback = `${makeBaseName(baseTitle).replace(/\.[a-z0-9]+$/i, '') || 'image'}.${realExt}`
      const candidate = sanitizeFilename(`${cleanBase}.${realExt}`, fallback)
      outName = candidate.toLowerCase().startsWith('download.') ? fallback : candidate
    } catch {
      outName = `${makeBaseName(baseTitle).replace(/\.[a-z0-9]+$/i, '') || 'image'}.${realExt}`
    }
    // Re-resolve against the real extension (Content-Type/magic may differ
    // from the initial guess) honoring the "When File Exists" policy:
    // Song.jpg / Song (1).jpg — never "01 - Song.jpg".
    finalPath = resolveFinalPath(folder, outName, { action: settings.onExistingFile }, sanitize)
    if (settings.onExistingFile === 'skip' && fileExists(finalPath.path)) {
      cleanupDir(tmpDir)
      deps.onUpdate({ ...task, state: 'Completed', progress: { ...task.progress, percent: 100, stage: 'done', message: 'File already exists' }, filePath: finalPath.path, fileSize: fileSizeBytes(finalPath.path) })
      deps.onCompleted(task, finalPath.path, fileSizeBytes(finalPath.path), true)
      return { state: 'completed' }
    }
    try {
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
      await this.moveFile(tmpFile, finalPath.path)
      const size = fileSizeBytes(finalPath.path)
      // Completed images use the file itself as the thumbnail (no second download).
      task.thumbnail = finalPath.path
      cleanupDir(tmpDir)
      deps.onUpdate({ ...task, state: 'Completed', progress: { ...task.progress, percent: 100, indeterminate: false, stage: 'done', phase: 'done', message: 'Completed' }, filePath: finalPath.path, fileSize: size, thumbnail: finalPath.path })
      deps.onCompleted(task, finalPath.path, size, false)
      logger.info(`[VIDAUD][IMAGE] Completed: ${finalPath.path} (${size} bytes, ext=${realExt})`)
      return { state: 'completed' }
    } catch (e) {
      const c = classifyError(e)
      cleanupDir(tmpDir)
      return { state: 'failed', error: c.message, errorKind: c.kind, errorDetails: this.errorDetails(e) }
    }
  }

  // -------------------------------------------------------------------------
  // Download phase

  private async performDownload(task: DownloadTask, req: DownloadRequest, tmpDir: string, deps: RunnerDeps, audioSelection?: AudioStreamSelection): Promise<boolean> {
    if (req.kind === 'video') {
      return this.downloadVideo(task, req, tmpDir, deps)
    }
    return this.downloadAudio(task, req, tmpDir, deps, audioSelection)
  }

  private async downloadVideo(task: DownloadTask, req: DownloadRequest, tmpDir: string, deps: RunnerDeps): Promise<boolean> {
    const tracker = this.makeTracker(task, 'video', deps)
    const settings = deps.settings()
    const fragments = settings.concurrentFragments

    let videoFile = streamFile(tmpDir, 'video')
    let audioFile = streamFile(tmpDir, 'audio')
    let combined = streamFile(tmpDir, 'combined')

    // Resume: seed the tracker from bytes already on disk (`.part` / fragment
    // files left by a paused attempt) so the percent continues from where it
    // stopped instead of resetting to 0.
    if (!videoFile) tracker.seed('video', partialBytes(tmpDir, 'video'))
    if (!audioFile) tracker.seed('audio', partialBytes(tmpDir, 'audio'))

    if (!combined && (videoFile === null || audioFile === null)) {
      const height = req.quality && req.quality !== 'best' ? Number(req.quality) : undefined
      const heightSel = height ? `[height<=${height}]` : ''
      const videoSel = `bestvideo${heightSel}/best${heightSel}/best`
      const audioSel = `bestaudio/best`

      const videoOpts = {
        url: req.url,
        format: videoSel,
        outDir: tmpDir,
        outTemplate: 'video.%(ext)s',
        control: deps.control,
        concurrentFragments: fragments,
        youtubeClients: YOUTUBE_PLAYER_CLIENTS,
        onProgress: (p: StreamProgress) => tracker.onStream('video', p)
      }
      const audioOpts = {
        url: req.url,
        format: audioSel,
        outDir: tmpDir,
        outTemplate: 'audio.%(ext)s',
        control: deps.control,
        concurrentFragments: fragments,
        youtubeClients: YOUTUBE_PLAYER_CLIENTS,
        onProgress: (p: StreamProgress) => tracker.onStream('audio', p)
      }

      let rv: Awaited<ReturnType<typeof downloadStream>>
      let ra: Awaited<ReturnType<typeof downloadStream>>

      // A paused attempt may already have finished one of the two streams.
      // Only download what is still missing: an existing finished file is
      // reused as-is, and an existing `.part` file makes yt-dlp continue at
      // the byte level (HTTP Range / fragment resume) into the SAME job.
      const videoMissing = videoFile === null
      const audioMissing = audioFile === null

      if (videoMissing && audioMissing) {
        if (settings.parallelVideoAudio) {
          // Download both streams simultaneously to cut wall-clock time in half.
          logger.info('[VIDAUD] Downloading video + audio streams in parallel...')
          const t0 = Date.now()
          ;[rv, ra] = await Promise.all([downloadStream(videoOpts), downloadStream(audioOpts)])
          logger.info(`[VIDAUD] Parallel streams took ${((Date.now() - t0) / 1000).toFixed(1)} s`)
        } else {
          logger.info('[VIDAUD] Downloading video stream...')
          rv = await downloadStream(videoOpts)
          if (!rv.cancelled && !rv.paused) {
            logger.info('[VIDAUD] Downloading audio stream...')
            ra = await downloadStream(audioOpts)
          } else {
            ra = { ok: false, files: [] }
          }
        }
      } else if (videoMissing) {
        // Audio finished before the pause -> download only the video stream.
        logger.info('[VIDAUD] Resume: audio stream already present, downloading only video stream...')
        rv = await downloadStream(videoOpts)
        ra = { ok: true, files: audioFile ? [audioFile] : [] }
      } else {
        // Video finished before the pause -> download only the audio stream.
        logger.info('[VIDAUD] Resume: video stream already present, downloading only audio stream...')
        rv = { ok: true, files: videoFile ? [videoFile] : [] }
        ra = await downloadStream(audioOpts)
      }

      if (rv.cancelled || ra.cancelled) return false
      if (rv.paused || ra.paused) return false

      videoFile = streamFile(tmpDir, 'video')
      audioFile = streamFile(tmpDir, 'audio')

      // Downloads a combined (video+audio) stream, trying progressively more
      // permissive YouTube player clients. Some videos expose video-only DASH
      // formats that YouTube refuses to serve without cookies (HTTP 403), and
      // some videos are DRM-marked on the tv/web clients. A combined stream on
      // the `android` / `android_vr` clients downloads for almost everything.
      const tryCombined = async (): Promise<'ok' | 'stopped' | 'failed'> => {
        for (const clients of [YOUTUBE_PLAYER_CLIENTS, ...YOUTUBE_COMBINED_FALLBACK_CLIENTS]) {
          logger.info(`[VIDAUD] WARN: trying combined stream (player_client=${clients})`)
          const rc = await downloadStream({
            url: req.url,
            format: `best${heightSel}/best`,
            outDir: tmpDir,
            outTemplate: 'combined.%(ext)s',
            control: deps.control,
            concurrentFragments: fragments,
            youtubeClients: clients,
            onProgress: (p) => tracker.onStream('video', p)
          })
          if (rc.cancelled || rc.paused) return 'stopped'
          combined = streamFile(tmpDir, 'combined')
          if (combined) {
            logger.info(`[VIDAUD] Combined stream downloaded (player_client=${clients})`)
            return 'ok'
          }
        }
        return 'failed'
      }

      if (!rv.ok || !videoFile) {
        // video stream selection failed -> try a combined (video+audio) stream
        logger.info(`[VIDAUD] WARN: video-only stream unavailable (${rv.error ?? 'no file'}), falling back to combined stream`)
        const res = await tryCombined()
        if (res === 'stopped') return false
        if (res === 'failed') throw new Error(rv.error || 'Unable to download this video.')
        videoFile = null
      } else if (!ra.ok || !audioFile) {
        // Video-only stream OK but audio failed -> probe the video file (some
        // combined streams slip through bestvideo) and fall back to combined.
        const probe = await this.ffmpeg.probe(videoFile).catch(() => null)
        if (!probe?.hasAudio) {
          logger.info('[VIDAUD] WARN: audio stream download failed, trying combined stream')
          const res = await tryCombined()
          if (res === 'stopped') return false
          if (res === 'failed') throw new Error('No audio stream available for this video.')
          videoFile = null
        } else {
          tracker.markDone('audio')
        }
      }

      if (videoFile) tracker.markDone('video')
      if (audioFile) tracker.markDone('audio')
    }

    const hasAny = videoFile !== null || audioFile !== null || combined !== null
    if (!hasAny) throw new Error('No media stream was downloaded for this video.')
    return true
  }

  /**
   * Downloads the audio for an MP3/audio-kind job.
   *
   * Pipeline (no FFmpeg until a REAL audio stream is confirmed):
   *   Analyze -> pick best audio-only stream -> download that exact stream
   *   -> wait for download to finish -> close handle -> FFprobe the file
   *   -> confirm audio stream -> return for conversion.
   *
   * A combined (video+audio) stream is only used as a last-resort fallback and
   * only when FFprobe confirms the file genuinely contains audio. A video-only
   * file is NEVER accepted as an audio source.
   */
  private async downloadAudio(task: DownloadTask, req: DownloadRequest, tmpDir: string, deps: RunnerDeps, selection?: AudioStreamSelection): Promise<boolean> {
    const tracker = this.makeTracker(task, 'audio', deps)
    const settings = deps.settings()

    // Resume: a paused attempt may already have finished the audio file (or
    // left `.part` bytes). Reuse a finished file after re-validating it, and
    // seed the tracker from on-disk bytes so the percent continues where it
    // stopped. A rejected file simply falls through to a fresh re-download.
    const existingAudio = streamFile(tmpDir, 'audio')
    if (existingAudio) {
      tracker.seed('audio', fileSizeBytes(existingAudio))
      const v = await this.validateDownloadedAudio(existingAudio, null)
      if (v.ok) {
        tracker.markDone('audio')
        logger.info(`[VIDAUD][AUDIO] Resume: reusing previously downloaded audio file (${fileSizeBytes(existingAudio)} bytes)`)
        return true
      }
      logger.error(`[VIDAUD][AUDIO] Resume: existing audio file rejected ([${v.code}] ${v.message}); re-downloading...`)
    } else {
      tracker.seed('audio', partialBytes(tmpDir, 'audio'))
    }

    // A fresh analysis guarantees a fresh stream selection per attempt, so a
    // Retry never reuses a stale format or an expired URL (spec: re-analyze,
    // refresh formats, select a fresh audio stream, fresh download attempt).
    let sel = selection
    if (!sel || (!sel.formatId && !sel.fallbackFormatId)) {
      try {
        const info = await fetchSingleInfo(req.url, undefined)
        sel = {
          formatId: info.bestAudio?.formatId,
          fallbackFormatId: info.bestAudioFallback?.formatId,
          hasAudio: info.hasAudio
        }
      } catch (e) {
        const c = classifyError(e)
        if (c.kind === 'permanent') throw new DownloadFailure(AudioFailure.AUDIO_STREAM_NOT_FOUND, c.message)
        throw new DownloadFailure(AudioFailure.AUDIO_DOWNLOAD_FAILED, c.message)
      }
    }

    if (!sel.hasAudio && !sel.formatId && !sel.fallbackFormatId) {
      throw new DownloadFailure(AudioFailure.AUDIO_STREAM_NOT_FOUND, 'No audio stream is available for this item.')
    }

    // Best-effort: resolve the exact stream URL and verify the HTTP response
    // BEFORE committing to a download. A definitively non-media payload
    // (HTML/JSON/text) is rejected immediately with full HTTP diagnostics.
    // Transient resolution/status problems are logged but NOT fatal here —
    // yt-dlp may succeed with proper headers/cookies, and the post-download
    // magic-byte + FFprobe validation is the final hard gate.
    const httpCheck = async (formatId: string): Promise<HttpResponseInfo | null> => {
      let streamUrl: string
      try {
        streamUrl = await resolveStreamUrl(req.url, formatId)
      } catch (e) {
        const c = classifyError(e)
        if (c.kind === 'permanent') {
          throw new DownloadFailure(AudioFailure.AUDIO_DOWNLOAD_INVALID, 'No audio stream is available for this item.', c.message)
        }
        logger.warn(`[VIDAUD][AUDIO] stream URL resolve failed (${c.message}); proceeding without HTTP pre-check.`)
        return null
      }
      logger.info(`[VIDAUD][AUDIO] Selected format: ${formatId}`)
      logger.info(`[VIDAUD][AUDIO] URL acquired: ${sanitizeUrl(streamUrl)}`)
      const info = await verifyMediaUrl(streamUrl)
      if (info.ok) return info
      const nonMediaPayload = info.status >= 200 && info.status < 300 && isNonMediaContentType(info.contentType)
      if (nonMediaPayload) {
        throw new DownloadFailure(AudioFailure.AUDIO_DOWNLOAD_INVALID, AUDIO_FILE_INVALID_MSG, formatHttpDiag(info))
      }
      logger.warn(`[VIDAUD][AUDIO] HTTP pre-check not fatal (status=${info.status}, ${info.error ?? 'n/a'}); proceeding, post-download validation will gate.`)
      return null
    }

    const tryDownload = async (formatId: string): Promise<{ ok: boolean; file: string | null; error?: string; cancelled?: boolean; paused?: boolean }> => {
      const r = await downloadStream({
        url: req.url,
        format: formatId,
        outDir: tmpDir,
        outTemplate: 'audio.%(ext)s',
        control: deps.control,
        writeThumbnail: settings.embedCoverArt,
        concurrentFragments: settings.concurrentFragments,
        youtubeClients: YOUTUBE_PLAYER_CLIENTS,
        onProgress: (p) => tracker.onStream('audio', p)
      })
      if (r.cancelled || r.paused) return { ok: false, file: null, cancelled: r.cancelled, paused: r.paused }
      const file = streamFile(tmpDir, 'audio')
      if (!r.ok || !file) return { ok: false, file: null, error: r.error || 'No audio file was produced.' }
      return { ok: true, file }
    }

    // One format attempt: HTTP pre-check -> download -> validate the REAL file.
    // A candidate is only accepted once the downloaded file is FFprobe-verified
    // to contain audio (never trust the extension or the format list alone). A
    // rejected candidate (e.g. [AUDIO_FILE_INVALID]) is recorded and the NEXT
    // candidate still gets a chance, so the combined-with-audio fallback is
    // always tried before the item is marked unavailable.
    const candidates: Array<{ id: string; label: string }> = []
    if (sel.formatId) candidates.push({ id: sel.formatId, label: 'Audio-only stream' })
    if (sel.fallbackFormatId) candidates.push({ id: sel.fallbackFormatId, label: 'Combined-with-audio fallback stream' })

    let lastFailure: { code: string; message: string; details: string } | null = null
    for (const candidate of candidates) {
      logger.info(`[VIDAUD][AUDIO] ${candidate.label}: ${candidate.id}`)
      let httpInfo: HttpResponseInfo | null = null
      try {
        httpInfo = await httpCheck(candidate.id)
      } catch (e) {
        const c = classifyError(e)
        const details = e instanceof DownloadFailure ? e.details || e.message : this.errorDetails(e)
        lastFailure = { code: e instanceof DownloadFailure ? e.code : AudioFailure.AUDIO_DOWNLOAD_FAILED, message: c.message, details }
        logger.error(`[VIDAUD][AUDIO] ${candidate.label} ${candidate.id} pre-check rejected: ${details}`)
        continue
      }
      logger.info(`[VIDAUD][AUDIO] Download started (format ${candidate.id})`)
      const res = await tryDownload(candidate.id)
      if (res.cancelled || res.paused) return false
      if (!res.ok || !res.file) {
        logger.info(`[VIDAUD][AUDIO] ${candidate.label} ${candidate.id} failed (${res.error ?? 'no file'})`)
        continue
      }
      const v = await this.validateDownloadedAudio(res.file, httpInfo)
      if (v.ok) {
        tracker.markDone('audio')
        logger.info(`[VIDAUD][AUDIO] Download size: ${fileSizeBytes(res.file)} bytes`)
        logger.info(`[VIDAUD][AUDIO] ${candidate.label} ${candidate.id} verified (audio confirmed)`)
        return true
      }
      logger.error(`[VIDAUD][AUDIO] ${candidate.label} ${candidate.id} rejected: [${v.code}] ${v.message}`)
      lastFailure = { code: v.code, message: v.message, details: v.details }
    }

    // Report the most informative failure: prefer the real-content validation
    // details (why the downloaded file was rejected) over a generic failure.
    if (lastFailure) {
      throw new DownloadFailure(lastFailure.code, lastFailure.message, lastFailure.details)
    }
    throw new DownloadFailure(AudioFailure.AUDIO_DOWNLOAD_FAILED, 'Audio download failed. Re-analyzing and retrying...')
  }

  /**
   * Real-content verification of a downloaded audio file, BEFORE FFmpeg.
   * Checks: file exists, size > 0 (and not unreasonably small), magic-byte
   * sniff (HTML/JSON/text error pages are rejected), and the file genuinely
   * contains an audio stream (FFprobe, never the file extension). Returns a
   * machine code + user message + detailed diagnostics for errorDetails.
   */
  private async validateDownloadedAudio(file: string, httpInfo: HttpResponseInfo | null): Promise<{ ok: boolean; code: string; message: string; details: string }> {
    const diag: Array<[string, string | number | null | undefined]> = []
    if (httpInfo) {
      diag.push(['HTTP Status', httpInfo.status])
      diag.push(['Content-Type', httpInfo.contentType ?? 'unknown'])
      if (httpInfo.contentLength !== null) diag.push(['Content-Length', httpInfo.contentLength])
      diag.push(['Final URL', httpInfo.finalUrl])
      diag.push(['Redirects', httpInfo.redirects])
    }

    if (!fileExists(file)) {
      diag.push(['File Size', 'missing'])
      return { ok: false, code: AudioFailure.AUDIO_FILE_EMPTY, message: AUDIO_FILE_INVALID_MSG, details: diagLines(diag) }
    }
    const size = fileSizeBytes(file)
    diag.push(['File Size', `${size} bytes`])
    if (size <= 0) {
      return { ok: false, code: AudioFailure.AUDIO_FILE_EMPTY, message: AUDIO_FILE_INVALID_MSG, details: diagLines(diag) }
    }
    if (size < 1024) {
      return { ok: false, code: AudioFailure.AUDIO_DOWNLOAD_INVALID, message: AUDIO_FILE_INVALID_MSG, details: diagLines(diag) }
    }

    // Magic-byte / file-signature sniff: never trust the extension. An HTML,
    // JSON or text payload saved as "audio" must be rejected before FFmpeg.
    const sniffed = sniffFileType(readFirstBytes(file, 1024))
    if (sniffed !== 'binary') {
      logger.error(`[VIDAUD][AUDIO] Invalid media response: downloaded file content looks like ${sniffed.toUpperCase()}, not audio.`)
      diag.push(['Detected Content', sniffed])
      return { ok: false, code: AudioFailure.AUDIO_DOWNLOAD_INVALID, message: AUDIO_FILE_INVALID_MSG, details: diagLines(diag) }
    }

    logger.info(`[VIDAUD][AUDIO] FFprobe started`)
    let probe: FfprobeResult
    try {
      probe = await this.ffmpeg.probe(file)
    } catch (e) {
      diag.push(['FFprobe Error', e instanceof Error ? e.message : String(e)])
      return { ok: false, code: AudioFailure.FFPROBE_FAILED, message: AUDIO_FILE_INVALID_MSG, details: diagLines(diag) }
    }
    const audioStreams = probe.streams.filter((s) => s.codecType === 'audio')
    const videoStreams = probe.streams.filter((s) => s.codecType === 'video')
    diag.push(['Container', probe.formatName ?? 'unknown'])
    diag.push(['Streams', probe.streams.length])
    diag.push(['Audio Streams', audioStreams.length])
    diag.push(['Video Streams', videoStreams.length])
    diag.push(['Audio Codec', probe.audioCodec ?? 'none'])
    logger.info(`[VIDAUD][AUDIO][FFPROBE] Input path: ${file}`)
    logger.info(`[VIDAUD][AUDIO][FFPROBE] Container: ${probe.formatName ?? 'unknown'}`)
    logger.info(`[VIDAUD][AUDIO][FFPROBE] Streams: ${probe.streams.length}`)
    logger.info(`[VIDAUD][AUDIO][FFPROBE] Audio streams: ${audioStreams.length}`)
    logger.info(`[VIDAUD][AUDIO][FFPROBE] Video streams: ${videoStreams.length}`)
    logger.info(`[VIDAUD][AUDIO][FFPROBE] Audio codec: ${probe.audioCodec ?? 'none'}`)
    if (!probe.hasAudio) {
      logger.error('[VIDAUD][AUDIO] Audio stream expected but missing from downloaded file.')
      diag.push(['FFprobe Error', 'no audio stream detected'])
      return { ok: false, code: AudioFailure.AUDIO_FILE_INVALID, message: AUDIO_FILE_INVALID_MSG, details: diagLines(diag) }
    }
    logger.info(`[VIDAUD][AUDIO] Audio streams found: ${audioStreams.length} (codec=${probe.audioCodec ?? '?'}, duration=${probe.duration ?? '?'}s)`)
    return { ok: true, code: '', message: '', details: '' }
  }

  // -------------------------------------------------------------------------
  // Processing phase

  private async performProcessing(task: DownloadTask, req: DownloadRequest, target: FormatDefinition, tmpDir: string, deps: RunnerDeps): Promise<string | null> {
    const signal = { aborted: false }
    const origControl = deps.control
    const poller = setInterval(() => {
      // Pausing must also abort the FFmpeg child (SIGTERM kill loop in
      // FfmpegManager.run), so a Pause during Processing/Converting actually
      // stops work instead of letting FFmpeg run to completion. The task then
      // returns 'paused' and resumes from the same attempt dir, where the
      // already-downloaded streams are reused and the output is regenerated.
      signal.aborted = origControl.cancelled || origControl.paused
    }, 200)

    const bandStart = req.kind === 'video' ? 90 : 85
    const bandEnd = req.kind === 'video' ? 98 : 97
    const procPhase: TaskPhase = req.kind === 'video' ? 'merge' : 'converting'

    const emit = (phase: TaskPhase, percent: number | null, message: string): void => {
      deps.onProgress({
        id: task.id,
        phase,
        downloadedBytes: 0,
        totalBytes: null,
        percent,
        speed: 0,
        eta: null
      })
      deps.onUpdate({ ...task, state: 'Converting', progress: { ...task.progress, percent: percent ?? 0, indeterminate: percent == null, stage: phase, phase, message } })
    }

    const onFfmpegProgress = (line: string): void => {
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(line)
      const dur = task.duration ?? 0
      if (m && dur > 0) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        const frac = Math.min(1, t / dur)
        const pct = bandStart + frac * (bandEnd - bandStart)
        emit(procPhase, Math.round(pct), PHASE_MESSAGE[procPhase])
      } else if (dur <= 0) {
        // Real duration unknown -> indeterminate animation during processing.
        emit(procPhase, null, PHASE_MESSAGE[procPhase])
      }
    }

    const advanced: AdvancedOptions = req.advanced ?? {}
    if (req.quality && req.quality !== 'best' && req.quality !== 'bestaudio' && !advanced.resolution) {
      const h = Number(req.quality)
      if (Number.isFinite(h) && h > 0) advanced.resolution = h
    }

    try {
      const out = join(tmpDir, `final.${target.extension}`)
      const caps = await FormatManager.getInstance().getCapabilities()
      const compat = new CompatibilityManager(caps.encoders)

      if (req.kind === 'video') {
        let videoFile = streamFile(tmpDir, 'video')
        let audioFile = streamFile(tmpDir, 'audio')
        const combined = streamFile(tmpDir, 'combined')

        const vOpts: ConvertOptions = {
          videoBitrateKbps: advanced.videoBitrate,
          audioBitrateKbps: advanced.audioBitrate,
          crf: advanced.crf,
          preset: advanced.preset,
          resolution: advanced.resolution,
          fps: advanced.fps,
          sampleRate: advanced.sampleRate,
          channels: advanced.channels
        }

        if (videoFile && audioFile) {
          const vProbe = await this.ffmpeg.probe(videoFile)
          let aProbe: FfprobeResult | null = null
          try {
            aProbe = await this.ffmpeg.probe(audioFile)
          } catch {
            aProbe = null
          }
          const source: SourceStreamInfo = {
            hasVideo: true,
            hasAudio: true,
            videoCodec: vProbe.videoCodec,
            audioCodec: aProbe?.audioCodec ?? vProbe.audioCodec,
            height: vProbe.height,
            fps: vProbe.fps,
            sampleRate: aProbe?.sampleRate,
            channels: aProbe?.channels
          }
          const plan = compat.planVideo(source, target, advanced)
          emit('merge', bandStart, 'Merging video and audio streams')
          logger.info(`[VIDAUD] Merging video + audio into ${target.label}...`)
          const t0 = Date.now()
          await this.ffmpeg.mergeStreams(videoFile, audioFile, out, target, plan, vOpts, onFfmpegProgress, signal)
          logger.info(`[VIDAUD] Merge completed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
        } else if (combined) {
          const probe = await this.ffmpeg.probe(combined)
          const source: SourceStreamInfo = {
            hasVideo: probe.hasVideo,
            hasAudio: probe.hasAudio,
            videoCodec: probe.videoCodec,
            audioCodec: probe.audioCodec,
            height: probe.height,
            fps: probe.fps,
            sampleRate: probe.sampleRate,
            channels: probe.channels
          }
          const plan = compat.planVideo(source, target, advanced)
          emit('remux', bandStart, 'Finalizing video (combined stream)')
          logger.info(`[VIDAUD] Finalizing combined stream into ${target.label}...`)
          const t0 = Date.now()
          await this.ffmpeg.remuxStreams(combined, out, target, plan, vOpts, onFfmpegProgress, signal)
          logger.info(`[VIDAUD] Remux completed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
        } else if (videoFile) {
          const probe = await this.ffmpeg.probe(videoFile)
          const source: SourceStreamInfo = {
            hasVideo: probe.hasVideo,
            hasAudio: probe.hasAudio,
            videoCodec: probe.videoCodec,
            audioCodec: probe.audioCodec,
            height: probe.height,
            fps: probe.fps,
            sampleRate: probe.sampleRate,
            channels: probe.channels
          }
          const plan = compat.planVideo(source, target, advanced)
          emit('remux', bandStart, 'Finalizing video')
          logger.info(`[VIDAUD] Finalizing video stream into ${target.label}...`)
          const t0 = Date.now()
          await this.ffmpeg.remuxStreams(videoFile, out, target, plan, vOpts, onFfmpegProgress, signal)
          logger.info(`[VIDAUD] Remux completed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
        } else {
          return null
        }
      } else {
        const audioFile = streamFile(tmpDir, 'audio')
        if (!audioFile) {
          throw new DownloadFailure(AudioFailure.AUDIO_DOWNLOAD_FAILED, 'Input audio file not found in temporary directory.')
        }
        if (!existsSync(audioFile)) {
          throw new DownloadFailure(AudioFailure.AUDIO_FILE_EMPTY, 'Input audio file is missing.')
        }
        if (statSync(audioFile).size <= 0) {
          throw new DownloadFailure(AudioFailure.AUDIO_FILE_EMPTY, 'Input audio file is empty (0 bytes).')
        }

        // Real content check BEFORE FFmpeg conversion — never trust the file
        // extension. If the file has no audio stream, we must NOT convert.
        let probe: FfprobeResult
        try {
          probe = await this.ffmpeg.probe(audioFile)
        } catch (e) {
          throw new DownloadFailure(AudioFailure.FFPROBE_FAILED, `Could not inspect the downloaded audio file: ${e instanceof Error ? e.message : String(e)}`)
        }
        if (!probe.hasAudio) {
          logger.error(`[VIDAUD][ERROR] Audio stream expected but missing from downloaded file: ${audioFile}`)
          throw new DownloadFailure(AudioFailure.AUDIO_FILE_INVALID, 'Audio stream expected but missing from downloaded file.')
        }
        logger.info(
          `[VIDAUD] Input ready for conversion: container=${probe.formatName ?? '?'}, streams=[${probe.streams.map((s) => `${s.codecType}:${s.codec ?? '?'}`).join(', ')}], audioCodec=${probe.audioCodec ?? '?'}, bitrate=${probe.bitrate ?? '?'}k, duration=${probe.duration ?? '?'}s`
        )

        const source: SourceStreamInfo = {
          hasVideo: probe.hasVideo,
          hasAudio: probe.hasAudio,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          sampleRate: probe.sampleRate,
          channels: probe.channels
        }
        const plan = compat.planAudio(source, target, advanced)
        if (plan.unsupported) {
          throw new DownloadFailure(AudioFailure.FFMPEG_FAILED, plan.unsupported)
        }

        // Confirm the MP3/audio encoder exists in this FFmpeg build (spec: an
        // FFmpeg without libmp3lame must never produce a broken file silently).
        const encoderName = plan.audio?.action === 'copy' ? 'copy' : normalizeEncoder(target.defaultAudioCodec) || (target.id === 'mp3' ? 'libmp3lame' : '')
        if (plan.audio?.action !== 'copy' && encoderName && !caps.encoders.has(encoderName)) {
          throw new DownloadFailure(
            AudioFailure.FFMPEG_FAILED,
            target.id === 'mp3' ? 'MP3 encoder is unavailable in this FFmpeg build.' : `Audio encoder "${encoderName}" is unavailable in this FFmpeg build.`
          )
        }

        emit('converting', bandStart, `Converting to ${target.label}`)
        let cover: string | null = null
        const settings = deps.settings()
        if (settings.embedCoverArt) {
          const img = imageFile(tmpDir)
          if (img) {
            if (extname(img).toLowerCase() === '.webp') {
              const jpg = join(tmpDir, 'cover.jpg')
              const res = await this.ffmpeg.run(['-y', '-i', img, '-q:v', '3', jpg])
              if (res.code === 0 && existsSync(jpg) && statSync(jpg).size > 0) cover = jpg
            } else {
              cover = img
            }
          }
        }
        const md = settings.embedMetadata ? buildMetadata(req, task) : {}
        const defaultBitrate = Number(settings.mp3Bitrate) || 320
        const reqBitrate = req.quality === 'best' || req.quality === 'bestaudio'
          ? defaultBitrate
          : Number(req.quality) || defaultBitrate

        const aOpts: ConvertOptions = {
          bitrateKbps: advanced.audioBitrate ?? reqBitrate,
          sampleRate: advanced.sampleRate,
          channels: advanced.channels,
          metadata: md,
          cover
        }
        const t0 = Date.now()
        try {
          await this.ffmpeg.convertAudio(audioFile, out, target, plan, aOpts, onFfmpegProgress, signal)
        } catch (e) {
          if (e instanceof FfmpegError) {
            // Report the REAL failure with full technical details (spec: exit
            // code, stderr, input codec/streams, encoder, bitrate, output).
            const technical = [
              '[FFMPEG_FAILED]',
              `Input: ${audioFile}`,
              `Input format: ${probe.formatName ?? 'unknown'}`,
              `Input codec: ${probe.audioCodec ?? 'unknown'}`,
              `Input streams: ${probe.streams.map((s) => s.codecType).join(', ')}`,
              `Encoder: ${encoderName || 'copy'}`,
              `Bitrate: ${aOpts.bitrateKbps ?? '?'}k`,
              `Output: ${out}`,
              `Exit code: ${e.code}`
            ]
            logger.error(`[VIDAUD] FFmpeg conversion failed:\n${technical.join('\n')}\n\n${e.output}`)
            throw new DownloadFailure(AudioFailure.FFMPEG_FAILED, `Failed to convert audio to ${target.label}.`, `${technical.join('\n')}\n\nFFmpeg stderr:\n${e.output.slice(-2000)}`)
          }
          throw e
        }
        logger.info(`[VIDAUD] ${target.label} conversion completed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
      }
      return existsSync(out) && statSync(out).size > 0 ? out : null
    } finally {
      clearInterval(poller)
    }
  }

  // -------------------------------------------------------------------------
  // Validation

  private async validateOutput(file: string, target: FormatDefinition): Promise<{ ok: boolean; error: string }> {
    try {
      if (!fileExists(file)) return { ok: false, error: 'Output file is missing.' }
      if (extname(file).toLowerCase() !== `.${target.extension}`) return { ok: false, error: 'Output file has the wrong extension.' }
      const size = statSync(file).size
      if (size <= 0) return { ok: false, error: 'Output file is empty.' }
      if (size < 1024 * 16) return { ok: false, error: 'Output file is too small to be a valid file.' }

      logger.info('[VIDAUD] Validating final file (decoding)...')
      const decodes = await this.ffmpeg.validate(file)
      if (!decodes) return { ok: false, error: 'The output file cannot be decoded.' }

      logger.info('[VIDAUD] Checking streams...')
      const probe = await this.ffmpeg.probe(file)
      if (!(probe.duration && probe.duration > 0)) {
        return { ok: false, error: 'Download failed: Duration is invalid or missing' }
      }
      if (probe.formatName && target.probeContainers.length > 0) {
        const okContainer = target.probeContainers.some((c) => probe.formatName!.toLowerCase().includes(c))
        if (!okContainer) {
          return { ok: false, error: `Output container is "${probe.formatName}" but expected ${target.label}.` }
        }
      }
      if (target.kind === 'video') {
        if (!probe.hasVideo) return { ok: false, error: 'Download failed: Video track is missing' }
        // MP4-family must never be produced without audio.
        if (['mp4', 'm4v', 'mov'].includes(target.id) && !probe.hasAudio) {
          return { ok: false, error: 'Download failed: Audio track is missing' }
        }
      } else if (!probe.hasAudio) {
        return { ok: false, error: 'Download failed: Audio track is missing' }
      }
      if (target.kind === 'audio' && probe.audioCodec) {
        const codec = probe.audioCodec.toLowerCase()
        const okCodec = ['mp3', 'libmp3lame'].some((c) => codec.includes(c))
        if (!okCodec) {
          return { ok: false, error: `Output audio codec is "${probe.audioCodec}" but expected MP3 (${target.label}).` }
        }
      }
      logger.info(`[VIDAUD] Video stream: ${probe.hasVideo ? 'OK' : '—'}, Audio stream: ${probe.hasAudio ? 'OK' : '—'} (${target.label})`)
      return { ok: true, error: '' }
    } catch (e) {
      return { ok: false, error: `Validation failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  // -------------------------------------------------------------------------

  private async moveFile(src: string, dest: string): Promise<void> {
    try {
      renameSync(src, dest)
    } catch (e) {
      // cross-device or locked -> copy then delete
      copyFileSync(src, dest)
      try {
        rmSync(src, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  private errorDetails(e: unknown): string {
    if (e instanceof DownloadFailure) {
      const detail = e.details && e.details.trim().length > 0 ? e.details : e.message
      return `[${e.code}] ${detail}`
    }
    if (e instanceof Error) {
      const errOut = (e as { output?: string }).output
      return `${e.name}: ${e.message}${errOut && errOut.trim().length > 0 ? '\n\nFFmpeg Technical Output:\n' + errOut.trim().slice(-2000) : ''}`
    }
    return String(e)
  }
}

export { basename }
