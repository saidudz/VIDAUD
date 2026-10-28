import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinary } from '../utils/binary'
import { logger } from '../utils/logger'
import type { AppSettings, ExcludeReason, MediaEntry, MediaInfo, MediaType, StreamProgress } from '@shared/types'
import { BrowserSessionManager } from '../cookies/BrowserSessionManager'
import { FormatManager } from '../formats/FormatManager'
import { hasImageExtension, analyzeImageUrl, probeImageUrl, imageInfoFromProbe, ImageProbeError, ImageFailure } from './image'
import { DownloadFailure } from './errors'
import { isImageSearchUrl, analyzeImageSearchPage, analyzeWebPageImages, imageEntryId } from './webImages'

export class YtDlpError extends Error {
  output: string
  constructor(message: string, output = '') {
    super(message)
    this.name = 'YtDlpError'
    this.output = output
  }
}

/**
 * Terminate a spawned yt-dlp process. yt-dlp.exe is a PyInstaller one-file
 * bundle: the parent launcher spawns a worker child that actually downloads,
 * so `child.kill()` (TerminateProcess on win32) only kills the launcher and
 * orphans the worker, which keeps writing bytes — pause/cancel would never
 * actually stop a download. On Windows the whole process tree is killed via
 * `taskkill /T /F`; elsewhere a plain SIGTERM reaches the process directly.
 */
function killProcessTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    /* ignore */
  }
}

let settingsGetter: (() => AppSettings) | null = null

export function setYtDlpSettingsGetter(fn: () => AppSettings): void {
  settingsGetter = fn
}

/**
 * Returns yt-dlp arguments to pass browser cookies for authenticated access.
 */
function getCookiesArgs(forceNoCookies = false, customSettings?: AppSettings): string[] {
  const cfg = customSettings ?? settingsGetter?.()
  return BrowserSessionManager.getInstance().getCookiesArgs(cfg, forceNoCookies)
}

export async function getYtDlpVersion(): Promise<string> {
  try {
    const bin = getYtDlp()
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync(bin, ['--version'])
    return stdout.trim()
  } catch (e) {
    logger.warn(`Failed to get yt-dlp version: ${e}`)
    return 'Unknown'
  }
}

export async function updateYtDlp(): Promise<{ success: boolean; version?: string; error?: string }> {
  try {
    const bin = getYtDlp()
    const execFileAsync = promisify(execFile)
    const { stdout, stderr } = await execFileAsync(bin, ['-U'])
    const version = await getYtDlpVersion()
    logger.info(`[VIDAUD] yt-dlp update result: ${(stdout || stderr).trim()}`)
    return { success: true, version }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn(`[VIDAUD] yt-dlp update failed: ${msg}`)
    return { success: false, error: 'Could not update yt-dlp.' }
  }
}

// yt-dlp's --progress-template syntax is `[TYPES:]TEMPLATE`, so a literal
// `download:` prefix would be consumed as the type selector and stripped.
// The emitted line is therefore: <id>|<percent>|<downloaded>|<total>|<speed>|<eta>
const PROGRESS_TEMPLATE =
  '%(info.id)s|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s'

export const DEFAULT_CONCURRENT_FRAGMENTS = 4

/**
 * YouTube player clients to use, most capable / best quality first.
 *
 * YouTube serves different formats (and different DRM/availability rules) per
 * player client. The default yt-dlp chain can stop at a client that reports
 * "This video is not available" / "DRM protected" even though another client
 * (e.g. `android`) serves the video fine. Passing an explicit comma-separated
 * list lets yt-dlp fall back to the next client whenever one refuses the
 * video, and guarantees analysis, stream resolution and download all use the
 * SAME client set — so a format selected during analysis always exists when
 * the downloader asks for it.
 *
 * `android` / `android_vr` are intentionally near the end: they are the most
 * permissive for DRM-marked / region-restricted videos (they serve combined
 * formats that never 403), but cap quality around 1080p, so the web clients
 * are preferred whenever YouTube cooperates.
 */
export const YOUTUBE_PLAYER_CLIENTS = 'tv,web_safari,ios,android,android_vr,web_embedded,web_music,web'

/**
 * Progressive combined-stream fallback clients for video downloads, used when
 * the video-only DASH stream 403s (a format the web/tv clients refuse to serve
 * without cookies) AND the recommended list still fails.
 */
export const YOUTUBE_COMBINED_FALLBACK_CLIENTS = ['android', 'android_vr']

/** Builds `--extractor-args youtube:player_client=...` args (no-ops on non-YouTube sites). */
function youtubeClientArgs(clients?: string): string[] {
  const list = clients?.trim()
  return list ? ['--extractor-args', `youtube:player_client=${list}`] : []
}

function getYtDlp(): string {
  const bin = resolveBinary('yt-dlp.exe')
  if (!bin) throw new YtDlpError('yt-dlp is not available. Please reinstall VIDAUD.')
  return bin
}

function parsePercent(s: string): number {
  const m = /([\d.]+)/.exec(s)
  return m ? Math.min(100, Math.max(0, Number(m[1]))) : 0
}

function parseIntOrUndef(s: string): number | undefined {
  const v = Number(s)
  return Number.isFinite(v) ? v : undefined
}

function parseSpeedBytes(s: string): number | undefined {
  if (!s || s === 'None' || s === 'N/A') return undefined
  const m = /([\d.]+)\s*([KMG]?)(?:i)?B\/s/i.exec(s)
  if (m) {
    const units: Record<string, number> = { '': 1, K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 }
    return Number(m[1]) * (units[m[2].toUpperCase()] ?? 1)
  }
  const raw = Number(s)
  return Number.isFinite(raw) ? raw : undefined
}

function parseEta(s: string): number | undefined {
  if (!s || s === 'None' || s === 'N/A') return undefined
  const n = Number(s)
  if (Number.isFinite(n)) return n
  const hm = /^(\d+):(\d+):(\d+)$/.exec(s)
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3])
  const ms = /^(\d+):(\d+)$/.exec(s)
  if (ms) return Number(ms[1]) * 60 + Number(ms[2])
  return undefined
}

function parseProgressLine(line: string): StreamProgress | null {
  if (!line.includes('|')) return null
  if (line.startsWith('[')) return null // [info]/[generic]/[download] messages
  const parts = line.split('|')
  if (parts.length < 4) return null
  const downloadedBytes = parseIntOrUndef(parts[2])
  if (downloadedBytes === undefined) return null
  return {
    percent: parsePercent(parts[1]),
    downloadedBytes,
    totalBytes: parseIntOrUndef(parts[3]),
    speedBytes: parseSpeedBytes(parts[4]),
    etaSeconds: parseEta(parts[5])
  }
}

function isResumableError(output: string): boolean {
  const low = output.toLowerCase()
  return (
    low.includes('requested format is not available') ||
    low.includes('unable to download') ||
    low.includes('http error') ||
    low.includes('request timed out') ||
    low.includes('timed out') ||
    low.includes('connection error') ||
    low.includes('network') ||
    low.includes('413') ||
    low.includes('429') ||
    low.includes('503') ||
    low.includes('the read operation timed out')
  )
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function runJsonRaw(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ out: string; err: string; code: number | null; killed: boolean }> {
  return new Promise((resolve) => {
    const bin = getYtDlp()
    let killed = false
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      killed = true
      killProcessTree(child)
    }, timeoutMs)
    const onAbort = (): void => {
      if (done) return
      killed = true
      killProcessTree(child)
      finish()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
    })
    child.on('error', (e) => {
      err += `\n${e.message}`
    })
    child.on('close', (code) => {
      finish()
      resolve({ out, err, code, killed })
    })
  })
}

async function runJson(args: string[], timeoutMs: number, signal?: AbortSignal, forceNoCookies = false): Promise<Record<string, unknown>> {
  const finalArgs = forceNoCookies ? args.filter((a, idx) => a !== '--cookies-from-browser' && (idx === 0 || args[idx - 1] !== '--cookies-from-browser')) : args
  const res = await runJsonRaw(finalArgs, timeoutMs, signal)

  if (res.killed) {
    throw new YtDlpError(signal?.aborted ? 'Analysis cancelled.' : 'Analysis timed out. The link may be unreachable or the playlist is too large.', res.err)
  }

  if (res.code !== 0) {
    // If execution failed AND we were using cookies AND it is a cookie DB lock/permission error, retry WITHOUT cookies!
    const isCookieErr = !forceNoCookies && BrowserSessionManager.getInstance().isCookieError(res.err)
    if (isCookieErr) {
      BrowserSessionManager.getInstance().setCookieDbUnavailable()
      const cfg = settingsGetter?.()
      BrowserSessionManager.getInstance().logSanitizedStatus(
        cfg?.browserName || 'auto',
        cfg?.browserProfile || 'Default',
        'detected (lock/permission issue)',
        'PermissionError / Copy Failed'
      )
      logger.info('[VIDAUD][COOKIES] Cookie access unavailable. Attempting fallback analysis without browser cookies.')

      // Strip cookies args and try again
      const fallbackArgs = args.filter((a, idx) => a !== '--cookies-from-browser' && (idx === 0 || args[idx - 1] !== '--cookies-from-browser'))
      const fallbackRes = await runJsonRaw(fallbackArgs, timeoutMs, signal)

      if (!fallbackRes.killed && fallbackRes.code === 0) {
        logger.info('[VIDAUD][COOKIES] Fallback analysis without cookies succeeded cleanly.')
        try {
          return JSON.parse(fallbackRes.out)
        } catch {
          throw new YtDlpError('Could not parse media information.', fallbackRes.out + '\n' + fallbackRes.err)
        }
      }

      // Fallback also failed: check if login is required
      const lowErr = (res.err + '\n' + fallbackRes.err).toLowerCase()
      if (
        lowErr.includes('requires sign in') ||
        lowErr.includes('sign in to confirm') ||
        lowErr.includes('login required') ||
        lowErr.includes('private video') ||
        lowErr.includes('member-only')
      ) {
        throw new YtDlpError('Unable to access the selected browser session.', res.err)
      }
    }

    const msg = extractError(res.err) || 'Failed to analyze the link.'
    throw new YtDlpError(msg, res.err)
  }

  try {
    return JSON.parse(res.out)
  } catch (e) {
    throw new YtDlpError('Could not parse media information.', res.out + '\n' + res.err)
  }
}

function extractError(err: string): string {
  const lines = err.split(/\r?\n/).filter((l) => /ERROR:/.test(l))
  const last = lines[lines.length - 1]
  return last ? last.replace(/^ERROR:\s*/, '') : ''
}

function collectHeights(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const heights = new Set<number>()
  for (const f of raw) {
    const vc = (f as Record<string, unknown>)?.vcodec
    const h = Number((f as Record<string, unknown>)?.height)
    if (vc && vc !== 'none' && Number.isFinite(h) && h > 0) heights.add(h)
  }
  return [...heights].sort((a, b) => b - a)
}

export interface AnalyzeOptions {
  signal?: AbortSignal
  forceNoCookies?: boolean
  /** Called as playlist entries stream in, so the UI can show "23 / 50". */
  onPlaylistProgress?: (done: number, total: number) => void
}

/** Why a playlist entry was hidden. Entries are only kept when they can be
 *  downloaded: a stable id, a valid URL and a real title. */
/** Why a playlist item was excluded and must never be shown or queued. */
export type PlaylistExcludeReason = ExcludeReason

/** Titles that carry no real metadata and are never used as a display name. */
const INVALID_PLAYLIST_TITLES = new Set(['untitled', 'unknown'])

function isInvalidPlaylistTitle(title: string): boolean {
  const t = title.trim().replace(/^\d+\s*[-–—.\s]\s*/, '').toLowerCase()
  return t.length === 0 || INVALID_PLAYLIST_TITLES.has(t)
}

function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const u = new URL(value.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Some playlist entries are marked unavailable/private by the source (e.g. a
 *  removed or age-restricted video) even though they still carry an id + URL. */
function isUnavailableEntry(e: Record<string, unknown>): boolean {
  if (e.is_unavailable === true) return true
  const availability = typeof e.availability === 'string' ? e.availability.toLowerCase() : ''
  if (availability === 'unavailable' || availability === 'private') return true
  const status = typeof e.status === 'string' ? e.status.toLowerCase() : ''
  return status === 'unavailable'
}

/** Flat-playlist entries for removed/private videos carry a placeholder title
 *  ("[Private video]", "[Video unavailable]", …) instead of a real one. They
 *  are permanently unavailable and are filtered out before the queue. */
function isUnavailableTitle(title: string): boolean {
  const t = title.trim().toLowerCase()
  return (
    t === 'video unavailable' ||
    t === 'this video is unavailable' ||
    t === 'this video is unavailable or has been removed' ||
    t === 'this video is not available' ||
    t === '[private video]' ||
    t === '[deleted video]' ||
    t === '[video unavailable]' ||
    t === '[removed video]' ||
    t === 'private video' ||
    t === 'deleted video' ||
    t === 'removed video'
  )
}

/**
 * Recovers a real display title from the entry's metadata before falling back
 * to exclusion. Flat playlist entries sometimes only carry a secondary title
 * field, or a placeholder title like "Untitled" that must not be shown.
 */
function recoverPlaylistTitle(e: Record<string, unknown>): string {
  const candidates = ['title', 'fulltitle', 'alt_title', 'track', 'name', 'display_id']
  for (const key of candidates) {
    const v = e[key]
    if (typeof v === 'string' && !isInvalidPlaylistTitle(v)) return v.trim()
  }
  const uploader = typeof e.uploader === 'string' ? e.uploader.trim() : ''
  if (uploader && !isInvalidPlaylistTitle(uploader)) return uploader
  return ''
}

interface MappedPlaylistEntry extends MediaEntry {
  excluded: boolean
  excludeReason?: PlaylistExcludeReason
}

/**
 * Validates a single flat-playlist entry. Entries without a stable id, a valid
 * URL or a recoverable title are excluded: they are never shown in the UI and
 * never enter the download queue. The excluded flag stays internal — the
 * renderer only receives valid entries plus the total counts.
 */
function mapPlaylistEntry(e: Record<string, unknown>, i: number): MappedPlaylistEntry {
  const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : ''
  const rawUrl = typeof e.url === 'string' && e.url.trim() ? e.url.trim() : ''
  const webpage = typeof e.webpage_url === 'string' && e.webpage_url.trim() ? e.webpage_url.trim() : ''
  const url = rawUrl || webpage
  const title = recoverPlaylistTitle(e)

  const base: MediaEntry = {
    id,
    title,
    url,
    index: i + 1,
    duration: Number(e.duration) || undefined,
    thumbnail: typeof e.thumbnail === 'string' ? e.thumbnail : undefined,
    uploader: typeof e.uploader === 'string' ? e.uploader : undefined
  }

  let excluded = false
  let excludeReason: PlaylistExcludeReason | undefined
  if (!id || /^item-\d+$/.test(id)) {
    excluded = true
    excludeReason = 'missing_id'
  } else if (!isValidHttpUrl(url)) {
    excluded = true
    excludeReason = 'missing_url'
  } else if (isUnavailableEntry(e)) {
    excluded = true
    excludeReason = 'unavailable'
  } else if (isUnavailableTitle(title)) {
    excluded = true
    excludeReason = 'unavailable'
  } else if (isInvalidPlaylistTitle(title)) {
    excluded = true
    excludeReason = typeof e.title === 'string' && e.title.trim().length > 0 ? 'invalid_title' : 'missing_title'
  } else if (e._type === 'playlist' || String(e.ie_key ?? '').toLowerCase().includes('playlist')) {
    excluded = true
    excludeReason = 'invalid_metadata'
  }

  return {
    ...base,
    available: !excluded,
    excluded,
    excludeReason
  }
}

/** Playlist-level metadata recovered from the first flat entry. */
export interface FlatPlaylistHeader {
  id?: string
  title?: string
  uploader?: string
  /** Total entries reported by the source (`n_entries`). */
  count?: number
  webpageUrl?: string
}

/**
 * Streams every playlist entry via `--flat-playlist --dump-json`. yt-dlp walks
 * the pagination/continuation tokens internally, so this never stops at the
 * first page. Entries arrive one JSON object per line, giving real progress
 * against the known `playlist_count`. The header is derived from the first
 * entry (`playlist_id`, `playlist_title`, `playlist_uploader`, `n_entries`),
 * which lets a single process serve both discovery and enumeration.
 */
function streamFlatEntries(url: string, knownTotal: number, opts: AnalyzeOptions): Promise<{ header: FlatPlaylistHeader | null; entries: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const bin = getYtDlp()
    const args = ['--no-warnings', '--flat-playlist', '--dump-json', '--socket-timeout', '30', ...getCookiesArgs(opts.forceNoCookies), url]
    let killed = false
    let done = false
    let stdoutBuffer = ''
    let stderr = ''
    let header: FlatPlaylistHeader | null = null
    const entries: Array<Record<string, unknown>> = []
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    const { signal } = opts

    // No-progress watchdog: abort if the stream stalls for 90s.
    let timer: NodeJS.Timeout | null = null
    const armTimer = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (done) return
        killed = true
        killProcessTree(child)
      }, 90_000)
    }
    armTimer()

    const finish = (): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      if (done) return
      killed = true
      killProcessTree(child)
      finish()
      reject(new YtDlpError('Analysis cancelled.', stderr))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (d: Buffer) => {
      armTimer()
      stdoutBuffer += d.toString()
      let idx: number
      while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, idx).trim()
        stdoutBuffer = stdoutBuffer.slice(idx + 1)
        if (!line) continue
        try {
          const obj = JSON.parse(line) as Record<string, unknown>
          if (obj && typeof obj === 'object') {
            if (header === null && obj._type !== 'video') {
              header = {
                id: typeof obj.playlist_id === 'string' ? obj.playlist_id : undefined,
                title: typeof obj.playlist_title === 'string' && obj.playlist_title.trim() ? obj.playlist_title.trim() : typeof obj.playlist === 'string' ? obj.playlist : undefined,
                uploader: typeof obj.playlist_uploader === 'string' ? obj.playlist_uploader : undefined,
                count: Number(obj.n_entries) > 0 ? Number(obj.n_entries) : undefined,
                webpageUrl: typeof obj.playlist_webpage_url === 'string' ? obj.playlist_webpage_url : undefined
              }
            }
            entries.push(obj)
            const total = Number(obj.n_entries) > 0 ? Number(obj.n_entries) : knownTotal
            opts.onPlaylistProgress?.(entries.length, total)
          }
        } catch {
          /* ignore malformed line */
        }
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (e) => {
      finish()
      reject(new YtDlpError(`yt-dlp failed to start: ${e.message}`, stderr))
    })
    child.on('close', (code) => {
      finish()
      if (killed) {
        reject(new YtDlpError(signal?.aborted ? 'Analysis cancelled.' : 'Timed out while fetching playlist items.', stderr))
        return
      }
      if (code !== 0) {
        reject(new YtDlpError(extractError(stderr) || 'Failed to fetch playlist items.', stderr))
        return
      }
      resolve({ header, entries })
    })
  })
}

/** An audio-bearing stream selected from the analyzed formats. */
export interface AudioStreamInfo {
  formatId: string
  ext: string
  acodec: string
  vcodec?: string
  /** Average bitrate (kbps) when reported. */
  abr?: number
  /** Total bitrate (kbps) when reported. */
  tbr?: number
  sampleRate?: number
  channels?: number
}

export interface SingleMediaInfo {
  title: string
  thumbnail?: string
  duration?: number
  uploader?: string
  hasVideo: boolean
  /** True when the source has ANY usable audio (audio-only or combined). */
  hasAudio: boolean
  /** Every audio-only stream, ranked best first (highest quality). */
  audioStreams: AudioStreamInfo[]
  /** The best audio-only stream to download for MP3/audio targets. */
  bestAudio?: AudioStreamInfo
  /**
   * The best combined (video+audio) stream. Used only as a last-resort
   * fallback for audio targets, and only after FFprobe confirms the file
   * really contains audio. NEVER a video-only stream.
   */
  bestAudioFallback?: AudioStreamInfo
}

/**
 * Small in-memory cache of `fetchSingleInfo` results, keyed by URL + cookie
 * mode. `analyzeUrl` seeds it for free from the metadata it already fetched,
 * so a download that follows an Analyze in the same session reuses the stream
 * selection instead of running a second full yt-dlp extraction. Bounded TTL +
 * invalidation on stale failures keeps retries honest (a dead stream is
 * dropped and the next attempt re-extracts fresh metadata).
 */
const SINGLE_INFO_TTL_MS = 10 * 60 * 1000
const SINGLE_INFO_MAX = 100

interface SingleInfoEntry {
  info: SingleMediaInfo
  ts: number
}

const singleInfoCache = new Map<string, SingleInfoEntry>()

function singleInfoKey(url: string, forceNoCookies: boolean): string {
  return `${url.trim()}|${forceNoCookies ? 'noc' : 'cookies'}`
}

function storeSingleInfo(key: string, info: SingleMediaInfo): void {
  singleInfoCache.set(key, { info, ts: Date.now() })
  if (singleInfoCache.size > SINGLE_INFO_MAX) {
    const oldest = singleInfoCache.keys().next()
    if (!oldest.done) singleInfoCache.delete(oldest.value)
  }
}

/** Seeds the single-info cache from an already-fetched `-J` result. */
export function seedSingleInfoCache(url: string, info: SingleMediaInfo, forceNoCookies = false): void {
  storeSingleInfo(singleInfoKey(url, forceNoCookies), info)
}

/** Drops every cache entry for a URL. Called when a download reports a
 *  stale/expired stream so the next fetch re-extracts fresh metadata. */
export function invalidateSingleInfoCache(url: string): void {
  const base = url.trim()
  singleInfoCache.delete(`${base}|cookies`)
  singleInfoCache.delete(`${base}|noc`)
}

/** Derives the stream selection from a full `-J` metadata dump. */
export function buildSingleInfo(full: Record<string, unknown>): SingleMediaInfo {
  const formats = Array.isArray(full.formats) ? full.formats : []
  const hasVideo = formats.some((f: Record<string, unknown>) => f.vcodec && f.vcodec !== 'none')
  const hasAudio = formats.some((f: Record<string, unknown>) => f.acodec && f.acodec !== 'none')
  const { audioStreams, bestAudio, bestAudioFallback } = pickAudioStreams(formats)
  return {
    title: recoverPlaylistTitle(full),
    thumbnail: typeof full.thumbnail === 'string' ? full.thumbnail : undefined,
    duration: Number(full.duration) || undefined,
    uploader: typeof full.uploader === 'string' ? full.uploader : undefined,
    hasVideo,
    hasAudio: hasAudio || !!bestAudio || !!bestAudioFallback,
    audioStreams,
    bestAudio,
    bestAudioFallback
  }
}

function pickAudioStreams(formats: unknown[]): { audioStreams: AudioStreamInfo[]; bestAudio?: AudioStreamInfo; bestAudioFallback?: AudioStreamInfo } {
  const entries = Array.isArray(formats) ? formats : []
  const toInfo = (f: Record<string, unknown>): AudioStreamInfo => {
    const num = (v: unknown): number | undefined => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : undefined
    }
    return {
      formatId: String(f.format_id ?? ''),
      ext: String(f.ext ?? ''),
      acodec: String(f.acodec ?? 'none'),
      vcodec: String(f.vcodec ?? 'none'),
      abr: num(f.abr) ?? num(f.tbr),
      tbr: num(f.tbr),
      sampleRate: num(f.asr),
      channels: num(f.channels)
    }
  }
  const all = entries.filter((f): f is Record<string, unknown> => !!f && typeof f === 'object').map(toInfo)

  const hasRealAudio = (a: AudioStreamInfo): boolean => !!a.acodec && a.acodec !== 'none' && a.acodec !== ''
  const isAudioOnly = (a: AudioStreamInfo): boolean => !a.vcodec || a.vcodec === '' || a.vcodec === 'none'

  const score = (a: AudioStreamInfo): number => a.abr ?? a.tbr ?? 0
  const byQuality = (x: AudioStreamInfo, y: AudioStreamInfo): number => score(y) - score(x)

  // Audio-only candidates only: a format is audio-only when it carries no
  // video track. We never treat a video stream as a valid audio source.
  const audioStreams = all.filter((a) => isAudioOnly(a) && hasRealAudio(a)).sort(byQuality)
  const combined = all.filter((a) => !isAudioOnly(a) && hasRealAudio(a)).sort(byQuality)

  return {
    audioStreams,
    bestAudio: audioStreams[0],
    bestAudioFallback: combined[0]
  }
}

/**
 * Fetches the real metadata for a single media URL. Used to recover real
 * titles for placeholder playlist entries and to refresh formats on retry.
 *
 * Every audio-kind job is analyzed with this before its download so that we
 * know the exact audio-only stream to fetch — never "best video". The chosen
 * stream is re-analyzed on each retry, giving a fresh stream URL.
 */
export async function fetchSingleInfo(url: string, signal?: AbortSignal, forceNoCookies = false): Promise<SingleMediaInfo> {
  const cacheKey = singleInfoKey(url, forceNoCookies)
  const hit = singleInfoCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < SINGLE_INFO_TTL_MS) {
    logger.info(`[VIDAUD] Single-info cache hit for ${cacheKey}`)
    return hit.info
  }
  // Use the explicit player-client list so the selected audio stream matches
  // what the downloader can actually fetch without cookies (the default chain
  // lists streams that 403 / are DRM-marked during download).
  const full = await runJson(['--no-warnings', '--no-playlist', '-J', ...youtubeClientArgs(), ...getCookiesArgs(forceNoCookies), url], 45000, signal, forceNoCookies)
  const info = buildSingleInfo(full)
  storeSingleInfo(cacheKey, info)
  return info
}

const MEDIA_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'dailymotion.com',
  'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com',
  'twitch.tv', 'soundcloud.com', 'mixcloud.com', 'bandcamp.com', 'rumble.com',
  'odysee.com', 'spotify.com', 'music.youtube.com'
]

/** True for media-platform hosts whose yt-dlp errors are authoritative. */
function isKnownMediaHost(rawUrl: string): boolean {
  let host: string
  try {
    host = new URL(rawUrl.trim()).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return false
  }
  return MEDIA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/** Builds the gallery MediaInfo for a web/search page extraction result. */
function toGalleryInfo(
  base: MediaInfo,
  url: string,
  gallery: { pageTitle: string; finalUrl: string; kind: 'web' | 'search'; images: Array<{ url: string; title: string; format: string | null; width?: number; height?: number; thumbnail?: string; originalUrl?: string; sourcePageUrl?: string; source?: string; originalAvailable?: boolean }>; excluded: number }
): MediaInfo {
  const entries: MediaEntry[] = gallery.images.map((img, i) => ({
    id: imageEntryId(img.url),
    title: img.title,
    url: img.url,
    index: i + 1,
    thumbnail: img.thumbnail || img.url,
    format: img.format ?? undefined,
    width: img.width,
    height: img.height,
    available: true,
    originalUrl: img.originalUrl,
    sourcePageUrl: img.sourcePageUrl,
    source: img.source,
    originalAvailable: img.originalAvailable
  }))
  logger.info(`[VIDAUD][WEBIMG] Gallery "${gallery.pageTitle}" -> ${entries.length} downloadable, ${gallery.excluded} excluded`)
  return {
    ...base,
    type: 'image-gallery',
    title: gallery.pageTitle,
    thumbnail: entries[0]?.thumbnail || entries[0]?.url,
    imageGalleryKind: gallery.kind,
    entryCount: entries.length + gallery.excluded,
    downloadableCount: entries.length,
    excludedCount: gallery.excluded,
    entries,
    hasVideo: false,
    hasAudio: false
  }
}

export async function analyzeUrl(url: string, opts: AnalyzeOptions = {}): Promise<MediaInfo> {
  logger.info(`[VIDAUD] Analyzing URL: ${url} (forceNoCookies=${!!opts.forceNoCookies})`)
  const base: MediaInfo = {
    type: 'unknown',
    title: '',
    webpageUrl: url,
    entries: [],
    availableHeights: [],
    hasVideo: false,
    hasAudio: false
  }

  // Fast path: obvious direct image URLs (…/photo.jpg, …/image.png?size=large)
  // are detected with a lightweight HEAD (fallback: minimal ranged GET) and
  // never run the full yt-dlp video/audio probe.
  try {
    if (hasImageExtension(url)) {
      try {
        const img = await analyzeImageUrl(url, { signal: opts.signal })
        if (img) {
          logger.info(`[VIDAUD][IMAGE] Direct image detected: ${img.filename} (${img.mimeType}${img.contentLength ? `, ${img.contentLength} bytes` : ''})`)
          return {
            ...base,
            type: 'image',
            title: img.title,
            thumbnail: img.thumbnail,
            imageExt: img.ext,
            fileSize: img.contentLength ?? undefined,
            webpageUrl: url
          }
        }
      } catch (e) {
        // analyzeImageUrl throws ImageProbeError carrying the full probe. A
        // definitive HTTP/transport failure on an obvious image extension is
        // authoritative (a .jpg URL that 400s/403s/404s is a dead or blocked
        // link) and is re-thrown straight away so the user sees the real
        // reason. Only a successful 2xx response whose body simply isn't an
        // image (e.g. a server serving an HTML page for the extension) falls
        // through to the full classification below — text/html legitimately
        // means a web page that may contain images.
        if (e instanceof ImageProbeError) {
          const p = e.probe
          const hardFail = p.status === 0 || p.status >= 400 || /timed out|failed|refused|server error|network|connection|redirect/i.test(p.error ?? '')
          if (hardFail) {
            logger.debug(`[VIDAUD][IMAGE] Direct-image probe hit a definitive failure (status=${p.status}, ${p.error ?? 'no error'}); surfacing it.`)
            throw e
          }
          logger.debug(`[VIDAUD][IMAGE] Direct-image probe did not confirm an image (${(p.error ?? p.contentType) || 'unknown'}); re-classifying the response.`)
        } else {
          throw e
        }
      }
    }
  } catch (e) {
    // If the image fast path itself raised a definitive HTTP/validation error
    // for an obvious image URL, surface it instead of running yt-dlp.
    if (e && typeof e === 'object' && 'code' in (e as Record<string, unknown>)) {
      throw e
    }
  }

  // Fast path: image-search result pages are recognized here instead of going
  // through the video/audio analyzer (which would only report
  // "Unable to analyze this link."). Extraction is best-effort over the
  // public page; protected/dynamic pages yield a specific guidance message.
  if (isImageSearchUrl(url)) {
    const gallery = await analyzeImageSearchPage(url, opts.signal)
    logger.info(`[VIDAUD][WEBIMG] Image-search page -> ${gallery.images.length} images`)
    return toGalleryInfo(base, url, gallery)
  }

  // Fast path: for URLs that are obviously playlists (youtube.com/playlist,
  // channel/@handle/user/c), skip the full `-J --playlist-items 1` probe. One
  // single `--flat-playlist --dump-json` process streams the header metadata
  // plus every entry — one spawn instead of two, and no per-item format probe.
  if (looksLikePlaylistUrl(url)) {
    return analyzePlaylistFast(url, opts, base)
  }

  const tFetch = Date.now()
  let full: Record<string, unknown>
  try {
    full = await runJson(['--no-warnings', '--playlist-items', '1', '-J', ...youtubeClientArgs(), ...getCookiesArgs(opts.forceNoCookies), url], 45000, opts.signal, opts.forceNoCookies)
  } catch (e) {
    if (!opts.forceNoCookies && e instanceof YtDlpError && BrowserSessionManager.getInstance().isCookieError(e.output || e.message)) {
      logger.info('[VIDAUD][COOKIES] Cookie access error in analyzeUrl. Retrying without cookies.')
      return analyzeUrl(url, { ...opts, forceNoCookies: true })
    }
    // The URL is not a media-platform host: CLASSIFY it instead of assuming
    // it is a direct image. A lightweight probe follows every redirect safely
    // (301/302/303/307/308) and records the FINAL URL, Content-Type and (for
    // images) magic bytes — it never stops at the first hop and never runs the
    // expensive yt-dlp video/audio analyzer against a plain web link.
    //   Direct image  -> single-image result (download it)
    //   text/html     -> web page: extract its images (og:image, <img>, ...)
    //   4xx/5xx/loop  -> specific, technical error (dead / blocked / redirect fail)
    //   other types   -> clear "unsupported" message, never "text/html error"
    if (!isKnownMediaHost(url)) {
      const probe = await probeImageUrl(url, { signal: opts.signal })
      if (probe.ok) {
        const img = imageInfoFromProbe(probe, url)
        logger.info(`[VIDAUD][IMAGE] Classified as a direct image via probe: ${img.filename} (${img.mimeType}${img.contentLength ? `, ${img.contentLength} bytes` : ''})`)
        return {
          ...base,
          type: 'image',
          title: img.title,
          thumbnail: img.thumbnail,
          imageExt: img.ext,
          fileSize: img.contentLength ?? undefined,
          webpageUrl: url
        }
      }
      const ct = (probe.contentType ?? '').split(';')[0].trim().toLowerCase()
      // Definitive HTTP/transport outcomes take priority over content-type:
      // a 404/403/400 body is an error page even when it declares text/html —
      // it must never be treated as "a web page that contains images".
      if (probe.status === 0 || probe.status >= 400) {
        const isRedirectLoop = probe.error !== undefined && /too many redirects|redirect/i.test(probe.error)
        throw new DownloadFailure(
          isRedirectLoop ? ImageFailure.REDIRECT_FAILED : ImageFailure.DIRECT_IMAGE_NOT_FOUND,
          probe.error ?? `The link returned HTTP ${probe.status}.`,
          `HTTP Status: ${probe.status}\nContent-Type: ${probe.contentType ?? 'unknown'}\nFinal URL: ${probe.finalUrl.split('?')[0]}`
        )
      }
      const isWebPage = ct.length > 0 && (ct.includes('html') || ct.includes('xhtml') || ct.startsWith('text/'))
      if (isWebPage) {
        // A text/html response is NOT a failure — it is a page that may
        // contain images. Inspect it: og:image / twitter:image / image_src /
        // <img> markup / JSON-LD (see webImages.extractImageUrls). Empty or
        // protected pages produce their own clear, specific error.
        try {
          const gallery = await analyzeWebPageImages(url, opts.signal)
          logger.info(`[VIDAUD][WEBIMG] ${probe.finalUrl.split('?')[0]} is a web page -> ${gallery.images.length} images (${gallery.excluded} excluded)`)
          return toGalleryInfo(base, url, gallery)
        } catch (webErr) {
          // analyzeWebPageImages throws DownloadFailures with specific,
          // actionable codes (blocked / http / no image / cancelled). Prefer
          // them over the original yt-dlp error.
          if (webErr instanceof DownloadFailure || (webErr && typeof webErr === 'object' && 'code' in (webErr as Record<string, unknown>))) {
            throw webErr
          }
          throw new DownloadFailure(ImageFailure.HTML_PAGE_NO_IMAGE, 'This link opens a web page. No directly downloadable image was found.', String(webErr))
        }
      }
      throw new DownloadFailure(
        ImageFailure.UNSUPPORTED_PAGE,
        ct ? `The link returned ${ct}, which VIDAUD could not handle.` : 'The link could not be classified as an image or a web page.',
        `HTTP Status: ${probe.status}\nFinal URL: ${probe.finalUrl.split('?')[0]}`
      )
    }
    throw e
  }

  const isPlaylist = full._type === 'playlist' || (Array.isArray(full.entries) && (full.entries as unknown[]).length > 1)

  if (isPlaylist) {
    // A "playlist" that yt-dlp's GENERIC extractor scraped off a plain web
    // page (e.g. a Wikipedia article's embedded media) is really just a web
    // page — and the Dashboard expects image results for web pages. Prefer
    // the web-image classifier for non-media hosts and only fall back to the
    // media playlist when the page contains no usable public images.
    if (!isKnownMediaHost(url) && String(full.extractor_key ?? '').toLowerCase() === 'generic') {
      const probe = await probeImageUrl(url, { signal: opts.signal })
      const ct = (probe.contentType ?? '').split(';')[0].trim().toLowerCase()
      const looksLikeHtml = ct.length > 0 && (ct.includes('html') || ct.includes('xhtml') || ct.startsWith('text/'))
      if (probe.status !== 0 && probe.status < 500 && looksLikeHtml) {
        try {
          const gallery = await analyzeWebPageImages(url, opts.signal)
          if (gallery.images.length > 0) {
            logger.info(`[VIDAUD][WEBIMG] Generic-scraped "playlist" resolved as a web page -> ${gallery.images.length} images (${gallery.excluded} excluded)`)
            return toGalleryInfo(base, url, gallery)
          }
        } catch {
          // No usable images on the page -> fall back to the media playlist.
        }
      }
    }
    const knownCount = Number(full.playlist_count) || 0
    const playlistTitle = String(full.title ?? full.fulltitle ?? 'Playlist')
    const raw = await streamFlatEntries(url, knownCount, opts)
    const header = raw.header ?? {
      id: typeof full.id === 'string' ? full.id : typeof full.playlist_id === 'string' ? full.playlist_id : undefined,
      title: playlistTitle,
      uploader: typeof full.uploader === 'string' ? full.uploader : undefined,
      count: knownCount,
      webpageUrl: url
    }
    return buildPlaylistInfo({ base, url, rawEntries: raw.entries, header, fallbackTitle: playlistTitle, tStart: tFetch, playlistThumbnail: typeof full.thumbnail === 'string' ? full.thumbnail : undefined })
  }

  const formats = Array.isArray(full.formats) ? full.formats : []
  // A single-entry result from yt-dlp's GENERIC extractor on a non-media host
  // (e.g. an extensionless image URL that redirects to a .jpg) is not
  // necessarily a video. When a lightweight probe confirms the resource is
  // actually an image, return the real single-image result instead of a
  // placeholder video card with no usable streams.
  if (!isKnownMediaHost(url) && String(full.extractor_key ?? '').toLowerCase() === 'generic') {
    const probe = await probeImageUrl(url, { signal: opts.signal })
    if (probe.ok) {
      const img = imageInfoFromProbe(probe, url)
      logger.info(`[VIDAUD][IMAGE] Generic-extracted direct media resolved as an image: ${img.filename} (${img.mimeType}${img.contentLength ? `, ${img.contentLength} bytes` : ''})`)
      return {
        ...base,
        type: 'image',
        title: img.title,
        thumbnail: img.thumbnail,
        imageExt: img.ext,
        fileSize: img.contentLength ?? undefined,
        webpageUrl: url
      }
    }
  }
  const hasVideo = formats.some((f: Record<string, unknown>) => f.vcodec && f.vcodec !== 'none')
  const hasAudio = formats.some((f: Record<string, unknown>) => f.acodec && f.acodec !== 'none')
  logger.info(`[VIDAUD] Metadata fetched in ${Date.now() - tFetch} ms (${formats.length} formats)`)
  // Seed the single-info cache from this same extraction so a subsequent
  // download reuses the stream selection instead of running a second full
  // `yt-dlp -J` for the identical URL (one extraction per job).
  seedSingleInfoCache(url, buildSingleInfo(full), opts.forceNoCookies)
  const formatSupport = await FormatManager.getInstance().computeFormatSupport(formats, hasVideo, hasAudio)
  const info: MediaInfo = {
    ...base,
    type: 'video',
    title: recoverPlaylistTitle(full) || String(full.id ?? ''),
    thumbnail: typeof full.thumbnail === 'string' ? full.thumbnail : undefined,
    duration: Number(full.duration) || undefined,
    uploader: typeof full.uploader === 'string' ? full.uploader : undefined,
    uploadDate: typeof full.upload_date === 'string' ? full.upload_date : undefined,
    availableHeights: collectHeights(formats),
    hasVideo,
    hasAudio,
    formatSupport
  }
  logger.info(`analyze video: ${info.title} (hasVideo=${hasVideo}, hasAudio=${hasAudio})`)
  return info
}

/** True for URLs yt-dlp always treats as a playlist. Only unambiguous playlist
 *  URLs take the fast single-process path; watch pages (even with a `list`
 *  query param) keep the classic probe so behavior is unchanged. */
function looksLikePlaylistUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'youtube.com') return false
  const p = u.pathname.toLowerCase()
  return p.startsWith('/playlist') || p.startsWith('/channel/') || p.startsWith('/user/') || p.startsWith('/c/') || /^\/@[\w.-]+/.test(p)
}

/** Single-process playlist discovery + enumeration used by the fast path. */
async function analyzePlaylistFast(url: string, opts: AnalyzeOptions, base: MediaInfo): Promise<MediaInfo> {
  const tStart = Date.now()
  let raw: { header: FlatPlaylistHeader | null; entries: Array<Record<string, unknown>> }
  try {
    raw = await streamFlatEntries(url, 0, opts)
  } catch (e) {
    if (!opts.forceNoCookies && e instanceof YtDlpError && BrowserSessionManager.getInstance().isCookieError(e.output || e.message)) {
      logger.info('[VIDAUD][COOKIES] Cookie access error in playlist fast path. Retrying without cookies.')
      return analyzeUrl(url, { ...opts, forceNoCookies: true })
    }
    throw e
  }
  const firstThumb = Array.isArray(raw.entries[0]?.thumbnails)
    ? (raw.entries[0].thumbnails as Array<Record<string, unknown>>).at(-1)?.url
    : typeof raw.entries[0]?.thumbnail === 'string'
      ? raw.entries[0].thumbnail
      : undefined
  return buildPlaylistInfo({ base, url, rawEntries: raw.entries, header: raw.header, fallbackTitle: '', tStart, playlistThumbnail: typeof firstThumb === 'string' ? firstThumb : undefined })
}

interface BuildPlaylistInput {
  base: MediaInfo
  url: string
  rawEntries: Array<Record<string, unknown>>
  header: FlatPlaylistHeader | null
  fallbackTitle: string
  tStart: number
  playlistThumbnail?: string
}

/**
 * Re-reads the full metadata for flat-playlist entries that were excluded ONLY
 * because no real title could be recovered (they have a valid id and URL).
 * Real metadata often carries a proper title that the flat entry lacks. When
 * the re-read still yields no real title, the entry stays excluded. Runs with
 * bounded concurrency so a large playlist never floods yt-dlp.
 */
async function recoverExcludedTitles(mapped: MappedPlaylistEntry[]): Promise<void> {
  const candidates = mapped.filter(
    (m) => m.excluded && (m.excludeReason === 'missing_title' || m.excludeReason === 'invalid_title') && !!m.id && !!m.url && isValidHttpUrl(m.url)
  )
  if (candidates.length === 0) return
  const CONCURRENCY = 4
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
    for (;;) {
      const i = cursor
      cursor += 1
      const m = candidates[i]
      if (!m) return
      try {
        const info = await fetchSingleInfo(m.url)
        const title = typeof info.title === 'string' ? info.title.trim() : ''
        if (isInvalidPlaylistTitle(title)) {
          logger.debug(`[VIDAUD][PLAYLIST] Item excluded / Index: ${m.index} / Reason: ${m.excludeReason} (metadata re-read found no real title)`)
          continue
        }
        m.title = title
        m.available = true
        m.excluded = false
        m.excludeReason = undefined
        logger.debug(`[VIDAUD][PLAYLIST] Item recovered via metadata re-read / Index: ${m.index} / Title: ${title}`)
      } catch (e) {
        logger.debug(`[VIDAUD][PLAYLIST] Item excluded / Index: ${m.index} / Reason: ${m.excludeReason} (metadata re-read failed: ${e instanceof Error ? e.message : String(e)})`)
      }
    }
  })
  await Promise.all(workers)
}

/**
 * Filters a MediaInfo playlist result through the same validity rules that
 * `analyzeUrl` applies, so stale cached results (or results produced before
 * the validation existed) can never surface "Untitled" / invalid entries in
 * the UI. Never creates jobs — the renderer and the queue sanitize on top.
 */
export function sanitizePlaylistEntries(info: MediaInfo): MediaInfo {
  if (info.type !== 'playlist' || !Array.isArray(info.entries)) return info
  const valid = info.entries.filter(
    (e) => !!e && typeof e.id === 'string' && !/^item-\d+$/.test(e.id.trim()) && typeof e.url === 'string' && isValidHttpUrl(e.url) && !isInvalidPlaylistTitle(e.title) && e.available !== false
  )
  return {
    ...info,
    entryCount: info.entryCount ?? info.entries.length,
    downloadableCount: valid.length,
    excludedCount: Math.max(0, info.entries.length - valid.length),
    entries: valid
  }
}

function buildPlaylistInfo(input: BuildPlaylistInput): Promise<MediaInfo> {
  return (async () => {
    const { base, url, rawEntries, header, fallbackTitle, tStart, playlistThumbnail } = input
    const knownCount = header?.count ?? rawEntries.length
    const playlistTitle = header?.title ?? fallbackTitle ?? 'Playlist'

    const mapped = rawEntries.map(mapPlaylistEntry)
    // Requirement: before excluding a title-less entry, re-read its metadata
    // to try to recover the real title. Only entries with a valid URL/id are
    // re-read; bounded concurrency keeps big playlists fast.
    await recoverExcludedTitles(mapped)
    const excludedEntries = mapped.filter((m) => m.excluded)
    for (const ex of excludedEntries) {
      logger.debug(`[VIDAUD][PLAYLIST] Item excluded / Reason: ${ex.excludeReason ?? 'unknown'} / Index: ${ex.index}`)
    }
    const entries = mapped.filter((m) => !m.excluded)
    const playlistCount = knownCount || mapped.length
    const truncated = knownCount > 0 && rawEntries.length < knownCount && rawEntries.length > 0
    logger.info(`[VIDAUD] Metadata fetched in ${Date.now() - tStart} ms (playlist: ${entries.length}/${playlistCount} entries, ${excludedEntries.length} excluded)`)
    const info: MediaInfo = {
      ...base,
      type: 'playlist',
      title: playlistTitle,
      playlistId: header?.id ?? (typeof base.playlistId === 'string' ? base.playlistId : undefined),
      playlistTitle,
      thumbnail: playlistThumbnail ?? (typeof base.thumbnail === 'string' ? base.thumbnail : undefined),
      uploader: header?.uploader ?? (typeof base.uploader === 'string' ? base.uploader : undefined),
      entryCount: playlistCount,
      downloadableCount: entries.length,
      excludedCount: excludedEntries.length,
      truncated,
      entries,
      hasVideo: true,
      hasAudio: true
    }
    logger.info(`analyze playlist: ${info.title} (${entries.length} entries)`)
    return info
  })()
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface DownloadControl {
  paused: boolean
  cancelled: boolean
}

/**
 * Resolves the direct, current media URL for an exact format id
 * (`yt-dlp -g -f <id>`). The returned URL is the ACTUAL audio/video stream,
 * freshly signed at resolve time — never the webpage, never a playlist, and
 * never a generic "best" selector. Used to verify the HTTP response before
 * committing to a download. Throws YtDlpError when resolution fails.
 */
export async function resolveStreamUrl(url: string, format: string, forceNoCookies = false): Promise<string> {
  const res = await runJsonRaw(
    ['--no-warnings', '--no-playlist', '-g', '-f', format, ...youtubeClientArgs(), ...getCookiesArgs(forceNoCookies), url],
    45000,
    undefined
  )
  if (res.killed) throw new YtDlpError('Timed out while resolving the stream URL.', res.err)
  if (res.code !== 0) {
    if (BrowserSessionManager.getInstance().isCookieError(res.err)) {
      BrowserSessionManager.getInstance().setCookieDbUnavailable()
    }
    const msg = extractError(res.err) || 'Failed to resolve the stream URL.'
    throw new YtDlpError(msg, res.err)
  }
  const line = (res.out || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^https?:\/\//i.test(l))
  if (!line) throw new YtDlpError('yt-dlp did not return a direct stream URL.', res.out + '\n' + res.err)
  return line
}

export interface DownloadStreamOptions {
  url: string
  format: string
  outDir: string
  outTemplate: string
  control: DownloadControl
  onProgress: (p: StreamProgress) => void
  writeThumbnail?: boolean
  concurrentFragments?: number
  forceNoCookies?: boolean
  /**
   * YouTube player client list to force via `--extractor-args`
   * (comma-separated, e.g. `tv,web_safari,ios`). Without cookies YouTube
   * serves 403 / DRM / bogus payloads for several stream classes (video-only
   * DASH and some combined formats) on the web/tv clients. Passing an explicit
   * list lets yt-dlp fall back to a permissive client (android/android_vr)
   * when one refuses the video, and keeps format selection consistent with
   * analysis/resolution. When omitted, no extractor args are passed.
   */
  youtubeClients?: string
}

export interface DownloadStreamResult {
  ok: boolean
  paused?: boolean
  cancelled?: boolean
  error?: string
  resumable?: boolean
  files: string[]
}

export async function downloadStream(opts: DownloadStreamOptions): Promise<DownloadStreamResult> {
  if (!existsSync(opts.outDir)) {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(opts.outDir, { recursive: true })
  }
  const before = new Set(readdirSync(opts.outDir))
  const bin = getYtDlp()
  const fragments = opts.concurrentFragments && opts.concurrentFragments > 0 ? opts.concurrentFragments : DEFAULT_CONCURRENT_FRAGMENTS
  const args = [
    '--no-warnings',
    '--newline',
    '--no-playlist',
    '--no-mtime',
    '--no-color',
    '--concurrent-fragments',
    String(fragments),
    '--retries',
    '4',
    '--fragment-retries',
    '6',
    '--socket-timeout',
    '30',
    ...getCookiesArgs(opts.forceNoCookies),
    '-f',
    opts.format,
    '--paths',
    opts.outDir,
    '-o',
    opts.outTemplate,
    '--progress-template',
    PROGRESS_TEMPLATE
  ]
  if (opts.writeThumbnail) {
    args.push('--write-thumbnail')
  }
  if (opts.youtubeClients) {
    args.push(...youtubeClientArgs(opts.youtubeClients))
  }
  args.push(opts.url)

  return new Promise((resolve) => {
    let stdout = ''
    let stdoutBuffer = ''
    let stderr = ''
    let killed = false
    let firstByte = false
    const tStart = Date.now()
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    const kill = (): void => {
      killed = true
      killProcessTree(child)
    }

    child.stdout.on('data', (d: Buffer) => {
      if (!firstByte) {
        firstByte = true
        logger.info(`[VIDAUD] First byte received in ${Date.now() - tStart} ms`)
      }
      stdout += d.toString()
      stdoutBuffer += d.toString()
      // Progress lines can be split across stdout chunks: accumulate until a
      // complete line is available, then parse it. Lines spanning chunk
      // boundaries would otherwise be dropped (spec: never fake/miss progress).
      let nl: number
      while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, nl).trim()
        stdoutBuffer = stdoutBuffer.slice(nl + 1)
        const p = parseProgressLine(line)
        if (p) opts.onProgress(p)
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    const controlTimer = setInterval(() => {
      if (opts.control.paused && child.exitCode === null) kill()
      if (opts.control.cancelled && child.exitCode === null) kill()
    }, 250)

    child.on('error', (e) => {
      clearInterval(controlTimer)
      resolve({ ok: false, error: `yt-dlp failed to start: ${e.message}`, files: [] })
    })

    child.on('close', (code) => {
      clearInterval(controlTimer)
      if (opts.control.paused && killed) {
        resolve({ ok: false, paused: true, files: [] })
        return
      }
      if (opts.control.cancelled && killed) {
        resolve({ ok: false, cancelled: true, files: [] })
        return
      }
      if (code !== 0) {
        const errText = extractError(stderr) || (stdout + stderr).slice(-500)
        // If cookie database access failed AND forceNoCookies is false, attempt fallback download without cookies!
        if (!opts.forceNoCookies && BrowserSessionManager.getInstance().isCookieError(stderr + '\n' + stdout)) {
          BrowserSessionManager.getInstance().setCookieDbUnavailable()
          const cfg = settingsGetter?.()
          BrowserSessionManager.getInstance().logSanitizedStatus(
            cfg?.browserName || 'auto',
            cfg?.browserProfile || 'Default',
            'detected (download copy failed)',
            'PermissionError / Lock'
          )
          logger.info('[VIDAUD][COOKIES] Download cookie access unavailable. Retrying download without cookies.')
          void downloadStream({ ...opts, forceNoCookies: true }).then(resolve)
          return
        }

        const lowErr = (stderr + '\n' + stdout).toLowerCase()
        if (
          lowErr.includes('requires sign in') ||
          lowErr.includes('sign in to confirm') ||
          lowErr.includes('login required') ||
          lowErr.includes('private video') ||
          lowErr.includes('member-only')
        ) {
          resolve({ ok: false, error: 'Unable to access the selected browser session.', resumable: false, files: [] })
          return
        }

        resolve({ ok: false, error: errText, resumable: isResumableError(errText), files: [] })
        return
      }
      const after = readdirSync(opts.outDir)
      const files = after.filter((f) => !before.has(f) && !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.webp') && !f.endsWith('.jpg') && !f.endsWith('.jpeg') && !f.endsWith('.png'))
      if (files.length > 0) {
        logger.info(`[VIDAUD] Download completed in ${((Date.now() - tStart) / 1000).toFixed(1)} s (${files.length} file(s))`)
      }
      resolve({ ok: true, files })
    })
  })
}

export function cleanupDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    logger.warn(`cleanup failed for ${dir}: ${e}`)
  }
}

export function joinDir(...parts: string[]): string {
  return join(...parts)
}
