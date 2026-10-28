import type { AdvancedOptions } from '@shared/types'
import type { FormatDefinition } from '@shared/formats'
import { normalizeCodec, normalizeEncoder } from './codecs'

export interface SourceStreamInfo {
  hasVideo: boolean
  hasAudio: boolean
  videoCodec?: string
  audioCodec?: string
  height?: number
  fps?: number
  sampleRate?: number
  channels?: number
}

export interface StreamDecision {
  /** `copy` = stream-copy, `encode` = transcode with `encoder`. */
  action: 'copy' | 'encode'
  encoder?: string
}

export interface ConversionPlan {
  video?: StreamDecision
  audio?: StreamDecision
  /** True when the pipeline must drop the video stream (audio-only target). */
  dropVideo: boolean
  /** Human-readable reason when the conversion cannot be produced. */
  unsupported?: string
}

/**
 * Compatibility Manager.
 *
 * Given the source streams (probed after download) and the target format,
 * decide per-stream whether to copy or encode, honouring the priority:
 *
 *     Copy > Remux > Convert
 *
 * A stream is copied when its codec is already compatible with the target
 * container; otherwise it is transcoded to the target's default encoder. An
 * explicit advanced override always wins and forces an encode.
 *
 * IMPORTANT: When `encoders` is empty (e.g. FFmpeg capability probe failed),
 * we fall back to always encoding with the target's defaultVideoCodec /
 * defaultAudioCodec rather than returning `unsupported`. This ensures downloads
 * work even when FFmpeg capability probing fails.
 */
export class CompatibilityManager {
  constructor(private encoders: Set<string>) {}

  /** Whether encoder capability checking is meaningful. */
  private get hasEncoderList(): boolean {
    return this.encoders.size > 0
  }

  /** True when the encoder is available (or when we have no capability list to check against). */
  private encoderAvailable(encoder: string): boolean {
    if (!this.hasEncoderList) return true // Can't check → assume available
    return this.encoders.has(encoder)
  }

  /** Decide the full conversion plan for video+audio -> target container. */
  planVideo(source: SourceStreamInfo, target: FormatDefinition, advanced?: AdvancedOptions): ConversionPlan {
    const plan: ConversionPlan = { dropVideo: false }

    if (source.hasVideo) {
      const needFilter = this.needVideoFilter(advanced, source)
      const advancedEncoder = normalizeEncoder(advanced?.videoCodec)
      if (advancedEncoder) {
        if (!this.encoderAvailable(advancedEncoder)) {
          plan.unsupported = `Video encoder "${advanced?.videoCodec}" is not available.`
          return plan
        }
        plan.video = { action: 'encode', encoder: advancedEncoder }
      } else if (!needFilter && target.defaultVideoCodec && this.canCopyVideo(source.videoCodec, target)) {
        plan.video = { action: 'copy' }
      } else if (target.defaultVideoCodec) {
        const enc = normalizeEncoder(target.defaultVideoCodec)
        if (this.encoderAvailable(enc)) {
          plan.video = { action: 'encode', encoder: enc }
        } else {
          // Encoder listed as unavailable AND we have a real capability list → unsupported
          plan.unsupported = `No video encoder available for ${target.label}.`
          return plan
        }
      }
      // If no defaultVideoCodec and no copy is possible, leave plan.video undefined
      // (FFmpeg will decide, which is fine for muxing containers like mkv/webm)
    }

    if (source.hasAudio) {
      const advancedEncoder = normalizeEncoder(advanced?.audioCodec)
      if (advancedEncoder) {
        if (!this.encoderAvailable(advancedEncoder)) {
          plan.unsupported = `Audio encoder "${advanced?.audioCodec}" is not available.`
          return plan
        }
        plan.audio = { action: 'encode', encoder: advancedEncoder }
      } else if (target.defaultAudioCodec && this.canCopyAudio(source.audioCodec, target)) {
        plan.audio = { action: 'copy' }
      } else if (target.defaultAudioCodec) {
        const enc = normalizeEncoder(target.defaultAudioCodec)
        if (this.encoderAvailable(enc)) {
          plan.audio = { action: 'encode', encoder: enc }
        } else {
          plan.unsupported = `No audio encoder available for ${target.label}.`
          return plan
        }
      }
    }

    return plan
  }

  /** Decide the plan for audio-only targets (video is dropped). */
  planAudio(source: SourceStreamInfo, target: FormatDefinition, advanced?: AdvancedOptions): ConversionPlan {
    const plan: ConversionPlan = { dropVideo: true }
    if (advanced?.audioCodec && normalizeEncoder(advanced.audioCodec)) {
      const enc = normalizeEncoder(advanced.audioCodec)
      if (!this.encoderAvailable(enc)) {
        plan.unsupported = `Audio encoder "${advanced.audioCodec}" is not available.`
        return plan
      }
      plan.audio = { action: 'encode', encoder: enc }
    } else if (source.hasAudio && target.defaultAudioCodec && this.canCopyAudio(source.audioCodec, target)) {
      plan.audio = { action: 'copy' }
    } else if (target.defaultAudioCodec) {
      const enc = normalizeEncoder(target.defaultAudioCodec)
      if (this.encoderAvailable(enc)) {
        plan.audio = { action: 'encode', encoder: enc }
      } else {
        plan.unsupported = `No audio encoder available for ${target.label}.`
      }
    } else {
      plan.audio = { action: 'encode', encoder: 'libmp3lame' }
    }
    return plan
  }

  private needVideoFilter(advanced: AdvancedOptions | undefined, source: SourceStreamInfo): boolean {
    if (!advanced) return false
    if (advanced.resolution && source.height && source.height > advanced.resolution) return true
    if (advanced.fps && source.fps && source.fps > advanced.fps + 0.5) return true
    return false
  }

  private canCopyVideo(codec: string | undefined, target: FormatDefinition): boolean {
    const c = normalizeCodec(codec)
    if (!c) return false
    return target.videoCodecs.includes(c)
  }

  private canCopyAudio(codec: string | undefined, target: FormatDefinition): boolean {
    const c = normalizeCodec(codec)
    if (!c) return false
    return target.audioCodecs.includes(c)
  }
}
