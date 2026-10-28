import { spawn } from 'node:child_process'
import { existsSync, statSync, rmSync } from 'node:fs'
import type { FormatDefinition } from '@shared/formats'
import type { ConversionPlan } from '../formats/CompatibilityManager'
import { resolveBinary } from '../utils/binary'
import { logger } from '../utils/logger'

/** One stream discovered inside an input file (mirrors ffprobe stream entries). */
export interface ProbeStream {
  /** Zero-based stream index (e.g. 0 for stream #0:0, 1 for #0:1). */
  index: number
  codecType: string
  codec?: string
  width?: number
  height?: number
  fps?: number
  sampleRate?: number
  channels?: number
  bitrate?: number
}

export interface FfprobeResult {
  formatName?: string
  videoCodec?: string
  audioCodec?: string
  hasVideo: boolean
  hasAudio: boolean
  width?: number
  height?: number
  fps?: number
  sampleRate?: number
  channels?: number
  /** Container-level bitrate (kb/s) when reported. */
  bitrate?: number
  duration?: number
  /** Every stream parsed from the container, in order. */
  streams: ProbeStream[]
}

export interface ConvertOptions {
  /** Default audio bitrate (kbps) for lossy audio targets. */
  bitrateKbps?: number
  videoBitrateKbps?: number
  audioBitrateKbps?: number
  crf?: number
  preset?: string
  resolution?: number
  fps?: number
  sampleRate?: number
  channels?: number
  metadata?: Record<string, string>
  cover?: string | null
}

export class FfmpegError extends Error {
  output: string
  code: number
  constructor(message: string, output: string, code = -1) {
    super(message)
    this.name = 'FfmpegError'
    this.output = output
    this.code = code
  }
}

const CHANNELS: Record<string, number> = {
  mono: 1,
  stereo: 2,
  '2.1': 3,
  quad: 4,
  '4.0': 4,
  '5.1': 6,
  '6.1': 7,
  '7.1': 8
}

/**
 * Cap on cached probe results. Each entry is keyed by a file identity
 * (path + size + mtime), so it is only valid while the file is unchanged.
 */
const PROBE_CACHE_MAX = 64

function qFromCrf(crf: number): number {
  return Math.max(2, Math.min(31, Math.round((crf - 18) / 2 + 5)))
}

function extractFfmpegErrorSummary(stderr: string): string {
  if (!stderr) return ''
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  const errLines = lines.filter((l) => /error|invalid|failed|cannot|could not|unsupported|unable to/i.test(l))
  if (errLines.length > 0) {
    return errLines.slice(-2).join(' | ').slice(0, 300)
  }
  const lastLines = lines.slice(-3).join(' ')
  return lastLines.slice(0, 200)
}

function videoEncodeArgs(encoder: string, opts: ConvertOptions): string[] {
  const args: string[] = ['-c:v', encoder]
  const crf = opts.crf ?? 20
  const preset = opts.preset ?? 'veryfast'
  switch (encoder) {
    case 'libx264':
    case 'libx265':
      args.push('-preset', preset, '-pix_fmt', 'yuv420p')
      if (opts.videoBitrateKbps) args.push('-b:v', `${opts.videoBitrateKbps}k`)
      else args.push('-crf', String(crf))
      break
    case 'libvpx-vp9':
    case 'libvpx':
    case 'libaom-av1':
      if (opts.videoBitrateKbps) args.push('-b:v', `${opts.videoBitrateKbps}k`)
      else args.push('-crf', String(Math.max(15, Math.min(63, crf + 10))))
      if (encoder !== 'libaom-av1') args.push('-row-mt', '1')
      break
    case 'mpeg2video':
    case 'mpeg4':
    case 'libxvid':
    case 'msmpeg4':
    case 'msmpeg4v2':
    case 'wmv2':
    case 'mjpeg':
    case 'libtheora':
      args.push('-q:v', String(qFromCrf(crf)), '-pix_fmt', 'yuv420p')
      break
    case 'prores':
    case 'prores_ks':
      args.push('-profile:v', '3', '-q:v', String(Math.max(1, Math.min(12, Math.round((crf - 18) / 2)))))
      break
    case 'dnxhd':
      args.push('-b:v', '50M', '-pix_fmt', 'yuv422p')
      break
    default:
      if (opts.videoBitrateKbps) args.push('-b:v', `${opts.videoBitrateKbps}k`)
      else args.push('-crf', String(crf), '-pix_fmt', 'yuv420p')
  }
  return args
}

function videoFilters(opts: ConvertOptions): string[] {
  const filters: string[] = []
  if (opts.resolution) filters.push(`scale=-2:${opts.resolution}`)
  if (opts.fps) filters.push(`fps=${opts.fps}`)
  return filters.length > 0 ? ['-vf', filters.join(',')] : []
}

function audioEncodeArgs(encoder: string, opts: ConvertOptions): string[] {
  const args: string[] = ['-c:a', encoder]
  if (encoder === 'libopencore_amrnb') {
    // AMR-NB is strictly 8 kHz mono.
    args.push('-ar', '8000', '-ac', '1')
    return args
  }
  const lossless = encoder === 'flac' || encoder === 'alac' || encoder.startsWith('pcm_')
  if (!lossless) {
    const bk = opts.audioBitrateKbps ?? opts.bitrateKbps ?? 320
    args.push('-b:a', `${bk}k`)
  }
  if (opts.sampleRate && opts.sampleRate > 0) args.push('-ar', String(opts.sampleRate))
  if (opts.channels && opts.channels > 0) args.push('-ac', String(opts.channels))
  return args
}

function containerExtras(target: FormatDefinition): string[] {
  if (['mp4', 'mov', 'm4v', 'ipod'].includes(target.muxer)) return ['-movflags', '+faststart']
  return []
}

/**
 * Parses `ffmpeg -i` header output (written to stderr) into a structured
 * result. This is the equivalent of probing with `ffprobe` for the bundled
 * build: it reads the REAL container and streams, not the file extension.
 */
function parseInputProbe(stderr: string): FfprobeResult {
  const res: FfprobeResult = { hasVideo: false, hasAudio: false, streams: [] }
  for (const line of stderr.split(/\r?\n/)) {
    const fmt = /Input #\d+, (.+?), from /.exec(line)
    if (fmt) res.formatName = fmt[1].trim()

    const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
    if (dur) res.duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])

    const containerBit = /bitrate: ([\d.]+) kb\/s/.exec(line)
    if (containerBit && res.duration !== undefined && res.bitrate === undefined) {
      res.bitrate = Number(containerBit[1])
    }

    // ffmpeg 7+ emits the AVStream internal id in brackets, e.g.
    //   Stream #0:0[0x1](eng): Audio: aac (LC) (mp4a / 0x6134706D), ...
    // The bracketed id is optional so both old (`#0:0(eng):`) and new
    // (`#0:0[0x1](eng):`) output formats are parsed.
    const sMatch = /Stream #\d+:\d+(?:\[[0-9a-fx]+\])?(?:\([\w.\-]+\))?: (Video|Audio|Data|Subtitle|Attachment): ([^,\n]+)/i.exec(line)
    if (!sMatch) continue
    const codecType = sMatch[1].toLowerCase()
    const codec = sMatch[2].trim().toLowerCase()
    const stream: ProbeStream = { index: res.streams.length, codecType, codec }

    if (codecType === 'video') {
      res.hasVideo = true
      if (!res.videoCodec) res.videoCodec = codec
      const vd = /(\d{2,4})x(\d{2,4})/.exec(line)
      if (vd) {
        stream.width = Number(vd[1])
        stream.height = Number(vd[2])
        if (!res.width) res.width = stream.width
        if (!res.height) res.height = stream.height
      }
      const fps = /([\d.]+) fps/.exec(line)
      if (fps) {
        stream.fps = Number(fps[1])
        if (!res.fps) res.fps = stream.fps
      }
    } else if (codecType === 'audio') {
      res.hasAudio = true
      if (!res.audioCodec) res.audioCodec = codec
      const sr = /(\d+) Hz/.exec(line)
      if (sr) {
        stream.sampleRate = Number(sr[1])
        if (!res.sampleRate) res.sampleRate = stream.sampleRate
      }
      const ch = /(mono|stereo|2\.1|quad|4\.0|5\.1|6\.1|7\.1|\d+\s*channels?)/i.exec(line)
      if (ch) {
        const chStr = ch[1].toLowerCase()
        const named = CHANNELS[chStr]
        const num = /(\d+)/.exec(chStr)?.[1]
        stream.channels = named ?? (num ? Number(num) : undefined)
        if (!res.channels && stream.channels) res.channels = stream.channels
      }
      const streamBit = /([\d.]+) kb\/s\s*$/.exec(line)
      if (streamBit) stream.bitrate = Number(streamBit[1])
    }

    res.streams.push(stream)
  }
  return res
}

export class FfmpegManager {
  private bin: string | null

  /**
   * In-memory probe cache keyed by file identity (path + size + mtime).
   * The same downloaded file is probed multiple times in one job (e.g. the
   * audio file is verified after download AND inspected again before
   * conversion); between those calls the file is byte-identical, so a cached
   * result is correct and avoids spawning a fresh ffmpeg process each time.
   */
  private probeCache = new Map<string, FfprobeResult>()

  constructor() {
    this.bin = resolveBinary('ffmpeg.exe')
    if (this.bin && existsSync(this.bin)) {
      logger.info(`[VIDAUD][FFMPEG] Binary resolved at: ${this.bin}`)
    } else {
      logger.warn('[VIDAUD][FFMPEG] Binary not found! Please ensure resources/bin/ffmpeg.exe exists.')
    }
  }

  get available(): boolean {
    return this.bin !== null && existsSync(this.bin)
  }

  getBinary(): string | null {
    return this.bin
  }

  run(
    args: string[],
    opts: { onProgress?: (line: string) => void; signal?: { aborted: boolean } } = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!this.bin || !existsSync(this.bin)) {
      return Promise.reject(new FfmpegError('FFmpeg is not installed or bundled correctly. Please reinstall VIDAUD.', '', -1))
    }
    const bin = this.bin
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      child.stderr!.on('data', (d: Buffer) => {
        const s = d.toString()
        stderr += s
        if (opts.onProgress) {
          for (const line of s.split(/\r\n|\r|\n/)) {
            if (line.includes('time=') || line.includes('bitrate=')) opts.onProgress(line)
          }
        }
      })
      child.on('error', (e) => {
        reject(new FfmpegError(`Failed to start FFmpeg: ${e.message}`, stderr, -1))
      })
      const killTimer = setInterval(() => {
        if (opts.signal?.aborted && child.exitCode === null) {
          try {
            child.kill('SIGTERM')
          } catch {
            /* ignore */
          }
        }
      }, 200)
      child.on('close', (code) => {
        clearInterval(killTimer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }

  /**
   * Probe a media file (ffprobe-equivalent using `ffmpeg -i` header parsing).
   *
   * This is a REAL content check: it inspects the actual file, never the file
   * extension. It reports every stream (container, codec_type, codec, sample
   * rate, channels, dimensions, duration, bitrate) so the downloader can
   * confirm an audio stream exists BEFORE starting any conversion.
   */
  async probe(file: string): Promise<FfprobeResult> {
    const empty: FfprobeResult = { hasVideo: false, hasAudio: false, streams: [] }
    if (!existsSync(file)) {
      return empty
    }
    let size: number
    let mtimeMs: number
    try {
      const stat = statSync(file)
      if (stat.size <= 0) {
        return empty
      }
      size = stat.size
      mtimeMs = stat.mtimeMs
    } catch {
      return empty
    }

    const cacheKey = `${file}|${size}|${mtimeMs}`
    const cached = this.probeCache.get(cacheKey)
    if (cached) {
      return cached
    }

    try {
      const { stderr } = await this.run(['-hide_banner', '-i', file])
      const result = parseInputProbe(stderr)
      if (this.probeCache.size >= PROBE_CACHE_MAX) {
        const oldest = this.probeCache.keys().next()
        if (!oldest.done) this.probeCache.delete(oldest.value)
      }
      this.probeCache.set(cacheKey, result)
      return result
    } catch (e) {
      logger.warn(`[VIDAUD][FFPROBE] probe failed for ${file}: ${e}`)
      return empty
    }
  }

  /**
   * Merge separate video + audio streams into a target container using a
   * pre-computed conversion plan (copy what's compatible, encode the rest).
   * Audio is ALWAYS included when the source provides it.
   */
  async mergeStreams(
    videoFile: string,
    audioFile: string,
    outFile: string,
    target: FormatDefinition,
    plan: ConversionPlan,
    opts: ConvertOptions,
    onProgress?: (line: string) => void,
    signal?: { aborted: boolean }
  ): Promise<void> {
    if (plan.unsupported) throw new FfmpegError(plan.unsupported, '', -1)
    if (!existsSync(videoFile) || statSync(videoFile).size <= 0) {
      throw new FfmpegError(`Input video file missing or empty: ${videoFile}`, '', -1)
    }
    if (!existsSync(audioFile) || statSync(audioFile).size <= 0) {
      throw new FfmpegError(`Input audio file missing or empty: ${audioFile}`, '', -1)
    }

    const args = ['-y', '-i', videoFile, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-max_muxing_queue_size', '1024']
    if (plan.video) {
      if (plan.video.action === 'copy') args.push('-c:v', 'copy')
      else args.push(...videoEncodeArgs(plan.video.encoder!, opts), ...videoFilters(opts))
    }
    if (plan.audio) {
      if (plan.audio.action === 'copy') args.push('-c:a', 'copy')
      else args.push(...audioEncodeArgs(plan.audio.encoder!, opts))
    }
    args.push(...containerExtras(target))
    args.push(outFile)
    const res = await this.run(args, { onProgress, signal })
    if (res.code !== 0) {
      if (existsSync(outFile)) {
        try { rmSync(outFile, { force: true }) } catch { /* ignore */ }
      }
      logger.error(`[VIDAUD][FFMPEG] exit code: ${res.code}`)
      logger.error(`[VIDAUD][FFMPEG] stderr:\n${res.stderr}`)
      const summary = extractFfmpegErrorSummary(res.stderr)
      throw new FfmpegError(`Failed to create ${target.label} file.${summary ? ' ' + summary : ''}`, res.stderr, res.code)
    }
  }

  /**
   * Finalize a single input file into a target container (combined stream or
   * video-only download). Preserves both streams from the input.
   */
  async remuxStreams(
    input: string,
    outFile: string,
    target: FormatDefinition,
    plan: ConversionPlan,
    opts: ConvertOptions,
    onProgress?: (line: string) => void,
    signal?: { aborted: boolean }
  ): Promise<void> {
    if (plan.unsupported) throw new FfmpegError(plan.unsupported, '', -1)
    if (!existsSync(input) || statSync(input).size <= 0) {
      throw new FfmpegError(`Input file missing or empty: ${input}`, '', -1)
    }

    const args = ['-y', '-i', input, '-map', '0:v:0', '-max_muxing_queue_size', '1024']
    if (plan.audio) args.push('-map', '0:a:0')
    if (plan.video) {
      if (plan.video.action === 'copy') args.push('-c:v', 'copy')
      else args.push(...videoEncodeArgs(plan.video.encoder!, opts), ...videoFilters(opts))
    }
    if (plan.audio) {
      if (plan.audio.action === 'copy') args.push('-c:a', 'copy')
      else args.push(...audioEncodeArgs(plan.audio.encoder!, opts))
    }
    args.push(...containerExtras(target))
    args.push(outFile)
    const res = await this.run(args, { onProgress, signal })
    if (res.code !== 0) {
      if (existsSync(outFile)) {
        try { rmSync(outFile, { force: true }) } catch { /* ignore */ }
      }
      logger.error(`[VIDAUD][FFMPEG] exit code: ${res.code}`)
      logger.error(`[VIDAUD][FFMPEG] stderr:\n${res.stderr}`)
      const summary = extractFfmpegErrorSummary(res.stderr)
      throw new FfmpegError(`Failed to create ${target.label} file.${summary ? ' ' + summary : ''}`, res.stderr, res.code)
    }
  }

  /** Convert an audio stream into a target audio format with resilient fallbacks. */
  async convertAudio(
    input: string,
    outFile: string,
    target: FormatDefinition,
    plan: ConversionPlan,
    opts: ConvertOptions,
    onProgress?: (line: string) => void,
    signal?: { aborted: boolean }
  ): Promise<void> {
    if (plan.unsupported || !plan.audio) {
      throw new FfmpegError(plan.unsupported ?? 'No audio stream to convert.', '', -1)
    }

    // 1. Verify input file existence and size
    if (!existsSync(input)) {
      throw new FfmpegError(`Input audio file not found: ${input}`, '', -1)
    }
    const stat = statSync(input)
    if (stat.size <= 0) {
      throw new FfmpegError(`Input audio file is empty (0 bytes): ${input}`, '', -1)
    }

    const encoder = plan.audio.action === 'copy'
      ? 'copy'
      : (plan.audio.encoder || (target.id === 'mp3' ? 'libmp3lame' : target.defaultAudioCodec))
    const bitrate = opts.audioBitrateKbps ?? opts.bitrateKbps ?? 320

    logger.info(`[VIDAUD][FFMPEG] Input: ${input}`)
    logger.info(`[VIDAUD][FFMPEG] Output: ${outFile}`)
    logger.info(`[VIDAUD][FFMPEG] Audio stream: 0:a:0`)
    logger.info(`[VIDAUD][FFMPEG] Encoder: ${encoder}`)
    logger.info(`[VIDAUD][FFMPEG] Bitrate: ${bitrate}k`)

    const buildArgs = (includeCover: boolean, includeMetadata: boolean): string[] => {
      const args = ['-y', '-i', input]
      const coverable = ['mp3', 'm4a', 'alac'].includes(target.id)
      const hasCover = includeCover && coverable && !!opts.cover && existsSync(opts.cover)
      if (hasCover) {
        args.push('-i', opts.cover!)
        args.push('-map', '0:a:0', '-map', '1:v:0')
      } else {
        args.push('-map', '0:a:0', '-vn')
      }

      if (plan.audio?.action === 'copy') {
        args.push('-c:a', 'copy')
      } else {
        args.push(...audioEncodeArgs(encoder, opts))
      }

      if (includeMetadata && opts.metadata) {
        for (const [k, v] of Object.entries(opts.metadata)) {
          if (v && v.trim().length > 0) {
            args.push('-metadata', `${k}=${v.trim()}`)
          }
        }
      }

      if (hasCover) {
        args.push(
          '-c:v', 'mjpeg',
          '-metadata:s:v', 'title=Album cover',
          '-metadata:s:v', 'comment=Cover (front)',
          '-id3v2_version', '3'
        )
      }

      if (target.muxer === 'ipod') {
        args.push('-movflags', '+faststart')
      }

      args.push(outFile)
      return args
    }

    const coverable = ['mp3', 'm4a', 'alac'].includes(target.id)
    const hasCover = coverable && !!opts.cover && existsSync(opts.cover)
    const hasMeta = !!opts.metadata && Object.keys(opts.metadata).length > 0

    // Attempt 1: Full conversion with cover art and metadata (if requested)
    let args = buildArgs(hasCover, hasMeta)
    let res = await this.run(args, { onProgress, signal })

    if (res.code === 0 && existsSync(outFile) && statSync(outFile).size > 0) {
      return
    }

    // Fallback 1: If cover art failed, retry without cover art
    if (hasCover) {
      logger.warn(`[VIDAUD][FFMPEG] Audio conversion with cover art failed (exit code ${res.code}). Retrying without cover art...`)
      if (existsSync(outFile)) {
        try { rmSync(outFile, { force: true }) } catch { /* ignore */ }
      }
      args = buildArgs(false, hasMeta)
      res = await this.run(args, { onProgress, signal })

      if (res.code === 0 && existsSync(outFile) && statSync(outFile).size > 0) {
        logger.info('[VIDAUD][FFMPEG] Audio conversion succeeded without cover art.')
        return
      }
    }

    // Fallback 2: If metadata also caused issues, retry clean conversion
    if (hasMeta) {
      logger.warn(`[VIDAUD][FFMPEG] Audio conversion with metadata failed (exit code ${res.code}). Retrying clean conversion...`)
      if (existsSync(outFile)) {
        try { rmSync(outFile, { force: true }) } catch { /* ignore */ }
      }
      args = buildArgs(false, false)
      res = await this.run(args, { onProgress, signal })

      if (res.code === 0 && existsSync(outFile) && statSync(outFile).size > 0) {
        logger.info('[VIDAUD][FFMPEG] Clean audio conversion succeeded.')
        return
      }
    }

    // If completely failed, cleanup partial output and log complete diagnostics
    if (existsSync(outFile)) {
      try { rmSync(outFile, { force: true }) } catch { /* ignore */ }
    }

    logger.error(`[VIDAUD][FFMPEG] exit code: ${res.code}`)
    logger.error(`[VIDAUD][FFMPEG] stderr:\n${res.stderr}`)
    const summary = extractFfmpegErrorSummary(res.stderr)
    throw new FfmpegError(`Failed to convert audio to ${target.label}.${summary ? ' ' + summary : ''}`, res.stderr, res.code)
  }

  /**
   * Decode the first few seconds of a file to validate integrity without a full decode.
   */
  async validate(file: string): Promise<boolean> {
    if (!existsSync(file)) return false
    try {
      if (statSync(file).size <= 0) return false
    } catch {
      return false
    }
    const res = await this.run(['-v', 'error', '-i', file, '-t', '5', '-f', 'null', '-'])
    return res.code === 0
  }
}

