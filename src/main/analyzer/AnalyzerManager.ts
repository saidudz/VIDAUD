import type { MediaInfo } from '@shared/types'
import { analyzeUrl, sanitizePlaylistEntries } from '../downloader/ytdlp'
import { logger } from '../utils/logger'
import { BrowserWindow, app } from 'electron'
import { IPC } from '@shared/types'
import { join, dirname } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'

interface CacheEntry {
  info: MediaInfo
  ts: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<MediaInfo>>()
const controllers = new Map<string, AbortController>()

const MAX_CACHE_ENTRIES = 200

function cacheFilePath(): string {
  return join(app.getPath('userData'), 'analyze-cache.json')
}

let writeTimer: NodeJS.Timeout | null = null

/** Debounced persistence so analyze runs during a busy download session never
 *  hit the disk synchronously. */
function schedulePersist(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    void persistCache()
  }, 2000)
}

async function persistCache(): Promise<void> {
  try {
    const file = cacheFilePath()
    await mkdir(dirname(file), { recursive: true })
    const payload: Array<{ url: string; ts: number; info: MediaInfo }> = []
    for (const [url, entry] of cache) payload.push({ url, ts: entry.ts, info: entry.info })
    await writeFile(file, JSON.stringify(payload), 'utf8')
    logger.debug(`[VIDAUD] Analyze cache persisted (${payload.length} entries)`)
  } catch (e) {
    logger.warn(`[VIDAUD] Failed to persist analyze cache: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Loads the persisted analyze cache at startup so repeat links are instant. */
export async function loadAnalyzeCache(): Promise<void> {
  try {
    const arr = JSON.parse(await readFile(cacheFilePath(), 'utf8')) as Array<{ url: string; ts: number; info: MediaInfo }>
    if (Array.isArray(arr)) {
      let loaded = 0
      for (const item of arr) {
        if (cache.size >= MAX_CACHE_ENTRIES) break
        if (item && typeof item.url === 'string' && item.info && typeof item.ts === 'number') {
          // Stale cached playlists may hold entries recorded before validation
          // existed ("Untitled" / invalid). Never let them reappear.
          cache.set(item.url, { info: sanitizePlaylistEntries(item.info), ts: item.ts })
          loaded++
        }
      }
      logger.info(`[VIDAUD] Analyze cache loaded (${loaded} entries)`)
    }
  } catch {
    /* no persisted cache yet */
  }
}

/** Drops one URL from the cache. Called when a download reports a 403/expired
 *  stream so the next analyze fetches fresh metadata instead of stale. */
export function invalidateAnalyzeCache(url: string): void {
  const key = url.trim()
  if (cache.delete(key)) {
    logger.info(`[VIDAUD] Analyze cache invalidated for ${key}`)
    schedulePersist()
  }
}

/** Broadcasts playlist entry discovery progress to every renderer window. */
function emitAnalyzeProgress(url: string, done: number, total: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !win.webContents) continue
    win.webContents.send(IPC.events.analyzeProgress, { url, done, total })
  }
}

export function cancelAnalyze(url: string): void {
  const key = url.trim()
  const controller = controllers.get(key)
  if (controller) {
    controller.abort()
    controllers.delete(key)
  }
  logger.info(`[VIDAUD] Analyze cancelled by user: ${key}`)
}

export function clearAnalyzeCache(): void {
  cache.clear()
  schedulePersist()
}

export async function analyzeWithCache(url: string, ttlMinutes: number, options?: { forceNoCookies?: boolean }): Promise<MediaInfo> {
  const key = url.trim()
  const cached = cache.get(key)
  // Negative TTL means "never reuse the cache — force a fresh analysis" (used
  // by automated smoke tests so a stale cached classification can never mask
  // a regression). 0 or positive falls back to the default 10-minute TTL.
  const ttlMs = ttlMinutes < 0 ? 0 : (ttlMinutes > 0 ? ttlMinutes : 10) * 60 * 1000
  if (ttlMs > 0 && !options?.forceNoCookies && cached && Date.now() - cached.ts < ttlMs) {
    logger.info(`[VIDAUD] Cache hit for ${key} (age ${Math.round((Date.now() - cached.ts) / 1000)}s)`)
    // Sanitize again so a "Refresh" can never resurrect excluded/placeholder
    // entries (an entry with no real title/URL/id is never re-shown).
    return sanitizePlaylistEntries(cached.info)
  }

  // Deduplicate concurrent requests for the same URL.
  const existing = inflight.get(key)
  if (existing) {
    logger.info(`[VIDAUD] Sharing in-flight analysis for ${key}`)
    return existing
  }

  const controller = new AbortController()
  controllers.set(key, controller)
  const t0 = Date.now()
  logger.info(`[VIDAUD] Analyze started: ${key}`)

  const promise = analyzeUrl(key, { signal: controller.signal, forceNoCookies: options?.forceNoCookies, onPlaylistProgress: (done, total) => emitAnalyzeProgress(key, done, total) })
    .then((info) => {
      cache.set(key, { info, ts: Date.now() })
      if (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = [...cache.keys()][0]
        if (oldest) cache.delete(oldest)
      }
      logger.info(`[VIDAUD] Analyze completed in ${((Date.now() - t0) / 1000).toFixed(2)} s`)
      schedulePersist()
      return info
    })
    .catch((e) => {
      if (controller.signal.aborted) {
        logger.info(`[VIDAUD] Analyze aborted (${((Date.now() - t0) / 1000).toFixed(2)} s)`)
      }
      throw e
    })
    .finally(() => {
      inflight.delete(key)
      controllers.delete(key)
    })

  inflight.set(key, promise)
  return promise
}
