import { existsSync, mkdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { FfmpegManager } from '../ffmpeg/FfmpegManager'
import { extensionCategory } from './CapabilityMatrix'
import { logger } from '../utils/logger'

/**
 * Produces small local previews (file:// URLs) for the Converter cards.
 *
 * - Images are served straight from disk (instant, no processing).
 * - Videos get a single frame extracted with FFmpeg at 1s (or the first frame
 *   when the clip is shorter), scaled down to ~240px so a batch of 100 files
 *   never stalls the UI.
 * - Audio files expose their embedded cover art when present (null otherwise,
 *   the UI falls back to a category icon).
 *
 * Extraction is bounded to `MAX_CONCURRENT` FFmpeg processes so adding a large
 * batch never spawns a process per file at once, and results are cached by
 * path so re-renders never re-probe.
 */
export class ThumbnailService {
  private cache = new Map<string, Promise<string | null>>()
  private queue: Array<() => void> = []
  private active = 0

  constructor(private ffmpeg: FfmpegManager) {}

  get(path: string): Promise<string | null> {
    const cached = this.cache.get(path)
    if (cached) return cached
    const pending = this.produce(path)
    this.cache.set(path, pending)
    return pending
  }

  private async produce(path: string): Promise<string | null> {
    if (!path || path.length === 0 || !existsSync(path)) return null
    const cat = extensionCategory(extname(path).slice(1))
    if (cat === 'image') {
      // Real image preview: serve the file itself.
      try {
        return pathToFileURL(path).href
      } catch {
        return null
      }
    }
    if (cat !== 'video' && cat !== 'audio') return null
    // Video frame / audio cover art require an FFmpeg pass — bound concurrency.
    return this.withLock(() => this.extractMedia(path, cat))
  }

  private async extractMedia(path: string, category: 'video' | 'audio'): Promise<string | null> {
    const dir = join(app.getPath('temp'), 'vidaud-thumbs')
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch (e) {
      logger.warn(`[VIDAUD][THUMB] could not create temp dir: ${e}`)
      return null
    }
    const out = join(dir, `thumb-${randomUUID()}.jpg`)

    // Videos: seek near the start (fast, no full decode) and scale to 240px.
    if (category === 'video') {
      const runSeek = async (seek: string): Promise<boolean> => {
        const res = await this.ffmpeg.run(['-y', '-ss', seek, '-i', path, '-an', '-frames:v', '1', '-vf', 'scale=-2:240', out])
        return res.code === 0 && existsSync(out) && this.fileHasSize(out)
      }
      try {
        if (await runSeek('1')) return pathToFileURL(out).href
        if (await runSeek('0')) return pathToFileURL(out).href
      } catch (e) {
        logger.debug(`[VIDAUD][THUMB] video frame extraction failed for ${path}: ${e}`)
      }
      return null
    }

    // Audio: grab the embedded cover art stream when one exists.
    try {
      const res = await this.ffmpeg.run(['-y', '-i', path, '-an', '-map', '0:v:0?', '-frames:v', '1', out])
      if (res.code === 0 && existsSync(out) && this.fileHasSize(out)) {
        return pathToFileURL(out).href
      }
    } catch (e) {
      logger.debug(`[VIDAUD][THUMB] cover art extraction failed for ${path}: ${e}`)
    }
    return null
  }

  private fileHasSize(file: string): boolean {
    try {
      return statSync(file).size > 0
    } catch {
      return false
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= 2) {
      await new Promise<void>((r) => this.queue.push(r))
    }
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      const next = this.queue.shift()
      if (next) next()
    }
  }
}
