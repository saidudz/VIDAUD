import { audioFormatList, videoFormatList, isFormatId, type FormatDefinition, type FormatStatus } from '@shared/formats'
import type { FormatInfo } from '@shared/types'
import { FfmpegManager } from '../ffmpeg/FfmpegManager'
import { logger } from '../utils/logger'
import { normalizeCodec } from './codecs'

export { normalizeCodec }

interface Capabilities {
  muxers: Set<string>
  encoders: Set<string>
}

export class FormatManager {
  private static instance: FormatManager | null = null
  private ffmpeg = new FfmpegManager()
  private caps: Capabilities | null = null
  private loading: Promise<Capabilities> | null = null

  static getInstance(): FormatManager {
    if (!FormatManager.instance) FormatManager.instance = new FormatManager()
    return FormatManager.instance
  }

  /** Probe the bundled FFmpeg once (muxers + encoders) and cache the result.
   *
   * IMPORTANT: ffmpeg -muxers and ffmpeg -encoders write their output to stderr,
   * NOT stdout. We read from stderr here, not stdout.
   */
  getCapabilities(): Promise<Capabilities> {
    if (this.caps) return Promise.resolve(this.caps)
    if (this.loading) return this.loading
    const t0 = Date.now()
    this.loading = (async () => {
      const muxers = new Set<string>()
      const encoders = new Set<string>()

      // ffmpeg writes -muxers and -encoders output to stderr, not stdout.
      try {
        const m = await this.ffmpeg.run(['-hide_banner', '-muxers'])
        // Try stderr first (correct), fall back to stdout
        const muxerOutput = m.stderr && m.stderr.length > 20 ? m.stderr : m.stdout
        for (const line of muxerOutput.split(/\r?\n/)) {
          const name = /^\s*\S+\s+([a-zA-Z0-9_]+)\s/.exec(line)?.[1]
          if (name) muxers.add(name)
        }
      } catch (e) {
        logger.warn(`[VIDAUD] ffmpeg -muxers failed: ${e}`)
      }

      try {
        const e = await this.ffmpeg.run(['-hide_banner', '-encoders'])
        // Try stderr first (correct), fall back to stdout
        const encoderOutput = e.stderr && e.stderr.length > 20 ? e.stderr : e.stdout
        for (const line of encoderOutput.split(/\r?\n/)) {
          const name = /^\s*\S+\s+([a-zA-Z0-9_]+)\s/.exec(line)?.[1]
          if (name) encoders.add(name)
        }
      } catch (e) {
        logger.warn(`[VIDAUD] ffmpeg -encoders failed: ${e}`)
      }

      // Safety fallback: if probing returned empty sets (ffmpeg not responding
      // as expected), inject the most common encoders and muxers so that
      // downloads can still proceed with the standard codec paths.
      if (muxers.size === 0) {
        logger.warn('[VIDAUD] FFmpeg muxer probe returned empty - using built-in fallback list')
        for (const m of [
          'mp4', 'ipod', 'matroska', 'webm', 'avi', 'mov', 'flv', 'ogg',
          'mp3', 'wav', 'flac', 'opus', 'adts', 'aiff'
        ]) muxers.add(m)
      }
      if (encoders.size === 0) {
        logger.warn('[VIDAUD] FFmpeg encoder probe returned empty - using built-in fallback list')
        for (const enc of [
          'libx264', 'libx265', 'libvpx', 'libvpx-vp9', 'mpeg4',
          'libmp3lame', 'aac', 'libopus', 'libvorbis', 'flac', 'pcm_s16le',
          'alac', 'libfdk_aac', 'eac3', 'ac3', 'mp2'
        ]) encoders.add(enc)
      }

      logger.info(`[VIDAUD] FFmpeg capabilities probed in ${Date.now() - t0} ms (${muxers.size} muxers, ${encoders.size} encoders)`)
      this.caps = { muxers, encoders }
      this.loading = null
      return this.caps
    })()
    return this.loading
  }

  /** Whether the format can be muxed at all with the bundled FFmpeg. */
  async canMux(formatId: string): Promise<boolean> {
    const def = this.definition(formatId)
    if (!def) return false
    const caps = await this.getCapabilities()
    return caps.muxers.has(def.muxer)
  }

  private definition(id: string): FormatDefinition | undefined {
    return isFormatId(id) ? (videoFormatList().concat(audioFormatList()).find((f) => f.id === id)) : undefined
  }

  /** All format definitions (static registry) merged with runtime availability. */
  async listFormats(): Promise<{ video: FormatInfo[]; audio: FormatInfo[] }> {
    const caps = await this.getCapabilities()
    const toInfo = (f: FormatDefinition): FormatInfo => {
      const encoderOk = (enc: string | undefined): boolean => !enc || enc === '' || caps.encoders.has(enc)
      const available = caps.muxers.has(f.muxer) && encoderOk(f.defaultVideoCodec) && encoderOk(f.defaultAudioCodec)
      const requiresConversion = f.kind === 'video' ? !['mp4', 'mkv', 'webm', 'mov'].includes(f.id) : !['mp3', 'm4a', 'aac', 'ogg', 'opus'].includes(f.id)
      return { ...f, available, requiresConversion }
    }
    return {
      video: videoFormatList().map(toInfo),
      audio: audioFormatList().map(toInfo)
    }
  }

  /**
   * Decide per-format status for an analyzed source:
   * - `direct`  a single source entry already has this container + compatible codecs
   * - `convert` needs an FFmpeg conversion that the bundled FFmpeg can do
   * - `unavailable` the container/codecs cannot be produced here
   */
  async computeFormatSupport(formats: unknown[], hasVideo: boolean, hasAudio: boolean): Promise<Record<string, FormatStatus>> {
    const caps = await this.getCapabilities()
    const list = videoFormatList().concat(audioFormatList())
    const out: Record<string, FormatStatus> = {}

    interface Entry { ext?: string; vcodec?: string; acodec?: string }
    const entries = (Array.isArray(formats) ? formats : []) as Entry[]

    for (const def of list) {
      const targetExt = def.extension
      let status: FormatStatus = 'unavailable'

      const muxerOk = caps.muxers.has(def.muxer)
      const encV = def.defaultVideoCodec ? caps.encoders.has(def.defaultVideoCodec) : true
      const encA = def.defaultAudioCodec ? caps.encoders.has(def.defaultAudioCodec) : true

      // Source capabilities gate: a video format needs video in the source.
      if (def.kind === 'video' && !hasVideo) {
        out[def.id] = 'unavailable'
        continue
      }
      if (def.kind === 'audio' && !hasAudio) {
        out[def.id] = 'unavailable'
        continue
      }

      if (muxerOk) {
        // Direct: a single source entry already in this container with copyable codecs.
        const direct = entries.some((e) => {
          if (e.ext !== targetExt) return false
          const v = normalizeCodec(e.vcodec)
          const a = normalizeCodec(e.acodec)
          const videoOk = !def.defaultVideoCodec || v === 'none' || v === '' || def.videoCodecs.includes(v)
          const audioOk = !def.defaultAudioCodec || a === 'none' || a === '' || def.audioCodecs.includes(a)
          return videoOk && audioOk
        })
        if (direct) {
          status = 'direct'
        } else if (encV && encA) {
          status = 'convert'
        }
      }
      out[def.id] = status
    }
    return out
  }
}
