/**
 * Central format registry for VIDAUD.
 *
 * This is the single source of truth for every format shown in the UI. A format
 * is only rendered if it has a real implementation behind it: `muxer` is the
 * FFmpeg muxer name, `defaultVideoCodec`/`defaultAudioCodec` are the FFmpeg
 * encoders used when a conversion is required, and `videoCodecs`/`audioCodecs`
 * list the codec names that can be stream-copied into the container.
 *
 * The FFmpeg build bundled with VIDAUD is probed at runtime (muxers + encoders)
 * so that a format with a missing muxer or required encoder is surfaced as
 * "Not Available" instead of producing a broken file.
 */

export type FormatStatus = 'direct' | 'convert' | 'unavailable'

export interface FormatDefinition {
  id: string
  label: string
  kind: 'video' | 'audio'
  extension: string
  mimeType: string
  /** FFmpeg muxer name used when producing this container. */
  muxer: string
  /** Encoder used when the video stream must be re-encoded into this container. */
  defaultVideoCodec?: string
  /** Encoder used when the audio stream must be re-encoded into this container. */
  defaultAudioCodec: string
  /** Codec names that can be stream-copied into this container (video). */
  videoCodecs: string[]
  /** Codec names that can be stream-copied into this container (audio). */
  audioCodecs: string[]
  /** ffprobe `format_name` fragments used during post-download validation. */
  probeContainers: string[]
  /** True for lossless audio targets (WAV/FLAC/AIFF/ALAC...) where bitrate is ignored. */
  lossless?: boolean
  /** `bitrate` formats accept a kbps bitrate; `lossless` and `pcm` ignore bitrate. */
  qualityKind: 'bitrate' | 'lossless'
}

// ---------------------------------------------------------------------------
// Video containers
// ---------------------------------------------------------------------------

const VIDEO_FORMATS: FormatDefinition[] = [
  {
    id: 'mp4',
    label: 'MP4',
    kind: 'video',
    extension: 'mp4',
    mimeType: 'video/mp4',
    muxer: 'mp4',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'hevc', 'av1', 'vp9', 'mpeg4'],
    audioCodecs: ['aac', 'mp3', 'ac3', 'eac3'],
    probeContainers: ['mp4', 'mov'],
    qualityKind: 'bitrate'
  },
  {
    id: 'mkv',
    label: 'MKV',
    kind: 'video',
    extension: 'mkv',
    mimeType: 'video/x-matroska',
    muxer: 'matroska',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg4', 'mpeg2video', 'theora', 'wmv2', 'prores', 'dnxhd', 'mjpeg'],
    audioCodecs: ['aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'flac', 'pcm_s16le', 'pcm_s24le', 'alac', 'mp2', 'wmav2'],
    probeContainers: ['matroska', 'webm'],
    qualityKind: 'bitrate'
  },
  {
    id: 'webm',
    label: 'WebM',
    kind: 'video',
    extension: 'webm',
    mimeType: 'video/webm',
    muxer: 'webm',
    defaultVideoCodec: 'libvpx-vp9',
    defaultAudioCodec: 'libopus',
    videoCodecs: ['vp9', 'vp8', 'av1'],
    audioCodecs: ['opus', 'vorbis'],
    probeContainers: ['matroska', 'webm'],
    qualityKind: 'bitrate'
  },
  {
    id: 'mov',
    label: 'MOV',
    kind: 'video',
    extension: 'mov',
    mimeType: 'video/quicktime',
    muxer: 'mov',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'hevc', 'prores', 'mpeg4', 'mjpeg'],
    audioCodecs: ['aac', 'mp3', 'ac3', 'eac3', 'pcm_s16le', 'pcm_s24le', 'alac'],
    probeContainers: ['mov', 'mp4'],
    qualityKind: 'bitrate'
  },
  {
    id: 'avi',
    label: 'AVI',
    kind: 'video',
    extension: 'avi',
    mimeType: 'video/x-msvideo',
    muxer: 'avi',
    defaultVideoCodec: 'mpeg4',
    defaultAudioCodec: 'libmp3lame',
    videoCodecs: ['mpeg4', 'h264', 'msmpeg4', 'msmpeg4v2', 'wmv2', 'mjpeg'],
    audioCodecs: ['mp3', 'aac', 'ac3', 'eac3', 'pcm_s16le', 'pcm_s24le', 'mp2'],
    probeContainers: ['avi'],
    qualityKind: 'bitrate'
  },
  {
    id: 'wmv',
    label: 'WMV',
    kind: 'video',
    extension: 'wmv',
    mimeType: 'video/x-ms-wmv',
    muxer: 'asf',
    defaultVideoCodec: 'wmv2',
    defaultAudioCodec: 'wmav2',
    videoCodecs: ['wmv2', 'wmv3', 'msmpeg4v2'],
    audioCodecs: ['wmav2', 'mp3'],
    probeContainers: ['asf'],
    qualityKind: 'bitrate'
  },
  {
    id: 'flv',
    label: 'FLV',
    kind: 'video',
    extension: 'flv',
    mimeType: 'video/x-flv',
    muxer: 'flv',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'flv1'],
    audioCodecs: ['aac', 'mp3'],
    probeContainers: ['flv'],
    qualityKind: 'bitrate'
  },
  {
    id: 'm4v',
    label: 'M4V',
    kind: 'video',
    extension: 'm4v',
    mimeType: 'video/x-m4v',
    muxer: 'm4v',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'hevc', 'mpeg4'],
    audioCodecs: ['aac', 'mp3', 'ac3', 'eac3'],
    probeContainers: ['mp4', 'mov'],
    qualityKind: 'bitrate'
  },
  {
    id: 'ts',
    label: 'TS',
    kind: 'video',
    extension: 'ts',
    mimeType: 'video/mp2t',
    muxer: 'mpegts',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'hevc', 'mpeg2video', 'mpeg4'],
    audioCodecs: ['aac', 'mp3', 'ac3', 'eac3'],
    probeContainers: ['mpegts'],
    qualityKind: 'bitrate'
  },
  {
    id: 'm2ts',
    label: 'M2TS',
    kind: 'video',
    extension: 'm2ts',
    mimeType: 'video/mp2t',
    muxer: 'mpegts',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'hevc', 'mpeg2video'],
    audioCodecs: ['aac', 'ac3', 'eac3'],
    probeContainers: ['mpegts'],
    qualityKind: 'bitrate'
  },
  {
    id: 'mts',
    label: 'MTS',
    kind: 'video',
    extension: 'mts',
    mimeType: 'video/mp2t',
    muxer: 'mpegts',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'hevc', 'mpeg2video'],
    audioCodecs: ['aac', 'ac3', 'eac3'],
    probeContainers: ['mpegts'],
    qualityKind: 'bitrate'
  },
  {
    id: '3gp',
    label: '3GP',
    kind: 'video',
    extension: '3gp',
    mimeType: 'video/3gpp',
    muxer: '3gp',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'mpeg4'],
    audioCodecs: ['aac', 'amr_nb'],
    probeContainers: ['mp4', 'mov', '3gp'],
    qualityKind: 'bitrate'
  },
  {
    id: '3g2',
    label: '3G2',
    kind: 'video',
    extension: '3g2',
    mimeType: 'video/3gpp2',
    muxer: '3g2',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264', 'mpeg4'],
    audioCodecs: ['aac', 'amr_nb'],
    probeContainers: ['mp4', 'mov', '3gp'],
    qualityKind: 'bitrate'
  },
  {
    id: 'mpg',
    label: 'MPG',
    kind: 'video',
    extension: 'mpg',
    mimeType: 'video/mpeg',
    muxer: 'mpeg',
    defaultVideoCodec: 'mpeg2video',
    defaultAudioCodec: 'mp2',
    videoCodecs: ['mpeg2video', 'mpeg1video'],
    audioCodecs: ['mp2', 'mp3', 'ac3'],
    probeContainers: ['mpeg'],
    qualityKind: 'bitrate'
  },
  {
    id: 'mpeg',
    label: 'MPEG',
    kind: 'video',
    extension: 'mpeg',
    mimeType: 'video/mpeg',
    muxer: 'mpeg',
    defaultVideoCodec: 'mpeg2video',
    defaultAudioCodec: 'mp2',
    videoCodecs: ['mpeg2video', 'mpeg1video'],
    audioCodecs: ['mp2', 'mp3', 'ac3'],
    probeContainers: ['mpeg'],
    qualityKind: 'bitrate'
  },
  {
    id: 'vob',
    label: 'VOB',
    kind: 'video',
    extension: 'vob',
    mimeType: 'video/mpeg',
    muxer: 'vob',
    defaultVideoCodec: 'mpeg2video',
    defaultAudioCodec: 'ac3',
    videoCodecs: ['mpeg2video', 'mpeg1video'],
    audioCodecs: ['ac3', 'mp2', 'pcm_s16le'],
    probeContainers: ['mpeg'],
    qualityKind: 'bitrate'
  },
  {
    id: 'ogv',
    label: 'OGV',
    kind: 'video',
    extension: 'ogv',
    mimeType: 'video/ogg',
    muxer: 'ogv',
    defaultVideoCodec: 'libtheora',
    defaultAudioCodec: 'libvorbis',
    videoCodecs: ['theora'],
    audioCodecs: ['vorbis', 'opus'],
    probeContainers: ['ogg'],
    qualityKind: 'bitrate'
  },
  {
    id: 'mxf',
    label: 'MXF',
    kind: 'video',
    extension: 'mxf',
    mimeType: 'application/mxf',
    muxer: 'mxf',
    defaultVideoCodec: 'mpeg2video',
    defaultAudioCodec: 'pcm_s16le',
    videoCodecs: ['dnxhd', 'mpeg2video', 'prores'],
    audioCodecs: ['pcm_s16le', 'pcm_s24le'],
    probeContainers: ['mxf'],
    qualityKind: 'bitrate'
  },
  {
    id: 'asf',
    label: 'ASF',
    kind: 'video',
    extension: 'asf',
    mimeType: 'video/x-ms-asf',
    muxer: 'asf',
    defaultVideoCodec: 'wmv2',
    defaultAudioCodec: 'wmav2',
    videoCodecs: ['wmv2', 'msmpeg4v2'],
    audioCodecs: ['wmav2', 'mp3'],
    probeContainers: ['asf'],
    qualityKind: 'bitrate'
  },
  {
    id: 'f4v',
    label: 'F4V',
    kind: 'video',
    extension: 'f4v',
    mimeType: 'video/x-f4v',
    muxer: 'f4v',
    defaultVideoCodec: 'libx264',
    defaultAudioCodec: 'aac',
    videoCodecs: ['h264'],
    audioCodecs: ['aac', 'mp3'],
    probeContainers: ['flv'],
    qualityKind: 'bitrate'
  }
]

// ---------------------------------------------------------------------------
// Audio formats
// ---------------------------------------------------------------------------

const AUDIO_FORMATS: FormatDefinition[] = [
  {
    id: 'mp3',
    label: 'MP3',
    kind: 'audio',
    extension: 'mp3',
    mimeType: 'audio/mpeg',
    muxer: 'mp3',
    defaultAudioCodec: 'libmp3lame',
    videoCodecs: [],
    audioCodecs: ['mp3'],
    probeContainers: ['mp3'],
    qualityKind: 'bitrate'
  },
  {
    id: 'm4a',
    label: 'M4A',
    kind: 'audio',
    extension: 'm4a',
    mimeType: 'audio/mp4',
    muxer: 'ipod',
    defaultAudioCodec: 'aac',
    videoCodecs: [],
    audioCodecs: ['aac', 'alac'],
    probeContainers: ['mp4', 'mov'],
    qualityKind: 'bitrate'
  },
  {
    id: 'aac',
    label: 'AAC',
    kind: 'audio',
    extension: 'aac',
    mimeType: 'audio/aac',
    muxer: 'adts',
    defaultAudioCodec: 'aac',
    videoCodecs: [],
    audioCodecs: ['aac'],
    probeContainers: ['aac', 'adts'],
    qualityKind: 'bitrate'
  },
  {
    id: 'wav',
    label: 'WAV',
    kind: 'audio',
    extension: 'wav',
    mimeType: 'audio/wav',
    muxer: 'wav',
    defaultAudioCodec: 'pcm_s16le',
    videoCodecs: [],
    audioCodecs: ['pcm_s16le', 'pcm_s24le'],
    probeContainers: ['wav'],
    lossless: true,
    qualityKind: 'lossless'
  },
  {
    id: 'flac',
    label: 'FLAC',
    kind: 'audio',
    extension: 'flac',
    mimeType: 'audio/flac',
    muxer: 'flac',
    defaultAudioCodec: 'flac',
    videoCodecs: [],
    audioCodecs: ['flac'],
    probeContainers: ['flac'],
    lossless: true,
    qualityKind: 'lossless'
  },
  {
    id: 'ogg',
    label: 'OGG',
    kind: 'audio',
    extension: 'ogg',
    mimeType: 'audio/ogg',
    muxer: 'ogg',
    defaultAudioCodec: 'libvorbis',
    videoCodecs: [],
    audioCodecs: ['vorbis', 'opus', 'flac'],
    probeContainers: ['ogg'],
    qualityKind: 'bitrate'
  },
  {
    id: 'opus',
    label: 'OPUS',
    kind: 'audio',
    extension: 'opus',
    mimeType: 'audio/ogg; codecs=opus',
    muxer: 'opus',
    defaultAudioCodec: 'libopus',
    videoCodecs: [],
    audioCodecs: ['opus'],
    probeContainers: ['ogg'],
    qualityKind: 'bitrate'
  },
  {
    id: 'wma',
    label: 'WMA',
    kind: 'audio',
    extension: 'wma',
    mimeType: 'audio/x-ms-wma',
    muxer: 'asf',
    defaultAudioCodec: 'wmav2',
    videoCodecs: [],
    audioCodecs: ['wmav2'],
    probeContainers: ['asf'],
    qualityKind: 'bitrate'
  },
  {
    id: 'aiff',
    label: 'AIFF',
    kind: 'audio',
    extension: 'aiff',
    mimeType: 'audio/aiff',
    muxer: 'aiff',
    defaultAudioCodec: 'pcm_s16le',
    videoCodecs: [],
    audioCodecs: ['pcm_s16le', 'pcm_s24le'],
    probeContainers: ['aiff'],
    lossless: true,
    qualityKind: 'lossless'
  },
  {
    id: 'alac',
    label: 'ALAC',
    kind: 'audio',
    extension: 'm4a',
    mimeType: 'audio/mp4',
    muxer: 'ipod',
    defaultAudioCodec: 'alac',
    videoCodecs: [],
    audioCodecs: ['alac', 'aac'],
    probeContainers: ['mp4', 'mov'],
    lossless: true,
    qualityKind: 'lossless'
  },
  {
    id: 'ac3',
    label: 'AC3',
    kind: 'audio',
    extension: 'ac3',
    mimeType: 'audio/ac3',
    muxer: 'ac3',
    defaultAudioCodec: 'ac3',
    videoCodecs: [],
    audioCodecs: ['ac3'],
    probeContainers: ['ac3'],
    qualityKind: 'bitrate'
  },
  {
    id: 'eac3',
    label: 'EAC3',
    kind: 'audio',
    extension: 'eac3',
    mimeType: 'audio/eac3',
    muxer: 'eac3',
    defaultAudioCodec: 'eac3',
    videoCodecs: [],
    audioCodecs: ['eac3'],
    probeContainers: ['eac3'],
    qualityKind: 'bitrate'
  },
  {
    id: 'amr',
    label: 'AMR',
    kind: 'audio',
    extension: 'amr',
    mimeType: 'audio/amr',
    muxer: 'amr',
    defaultAudioCodec: 'libopencore_amrnb',
    videoCodecs: [],
    audioCodecs: ['amr_nb'],
    probeContainers: ['amr'],
    qualityKind: 'bitrate'
  },
  {
    id: 'mp2',
    label: 'MP2',
    kind: 'audio',
    extension: 'mp2',
    mimeType: 'audio/mpeg',
    muxer: 'mp2',
    defaultAudioCodec: 'mp2',
    videoCodecs: [],
    audioCodecs: ['mp2'],
    probeContainers: ['mp2'],
    qualityKind: 'bitrate'
  },
  {
    id: 'ape',
    label: 'APE',
    kind: 'audio',
    extension: 'ape',
    mimeType: 'audio/ape',
    muxer: 'ape',
    defaultAudioCodec: '',
    videoCodecs: [],
    audioCodecs: [],
    probeContainers: ['ape'],
    lossless: true,
    qualityKind: 'lossless'
  },
  {
    id: 'au',
    label: 'AU',
    kind: 'audio',
    extension: 'au',
    mimeType: 'audio/basic',
    muxer: 'au',
    defaultAudioCodec: 'pcm_s16le',
    videoCodecs: [],
    audioCodecs: ['pcm_s16le', 'pcm_s24le'],
    probeContainers: ['au'],
    lossless: true,
    qualityKind: 'lossless'
  }
]

export const ALL_FORMATS: FormatDefinition[] = [...VIDEO_FORMATS, ...AUDIO_FORMATS]

const byId = new Map<string, FormatDefinition>(ALL_FORMATS.map((f) => [f.id, f]))

export function getFormat(id: string): FormatDefinition | undefined {
  return byId.get(id)
}

export function isVideoFormatId(id: string): boolean {
  const f = byId.get(id)
  return f?.kind === 'video'
}

export function isAudioFormatId(id: string): boolean {
  const f = byId.get(id)
  return f?.kind === 'audio'
}

export function isFormatId(id: string): boolean {
  return byId.has(id)
}

export function videoFormatList(): FormatDefinition[] {
  return VIDEO_FORMATS
}

export function audioFormatList(): FormatDefinition[] {
  return AUDIO_FORMATS
}

// ---------------------------------------------------------------------------
// Image formats (direct download, no FFmpeg conversion — original bytes preserved)
// ---------------------------------------------------------------------------

/** Image extensions VIDAUD can download directly (lowercase, no dot). */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'svg'] as const

export type ImageFormatId = (typeof IMAGE_EXTENSIONS)[number]

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml'
}

export function isImageFormatId(id: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(String(id || '').toLowerCase())
}

export function imageMimeForExt(ext: string): string {
  return IMAGE_MIME[String(ext || '').toLowerCase()] ?? 'image/*'
}

export function imageFormatList(): Array<{ id: string; label: string; extension: string; mimeType: string }> {
  return (IMAGE_EXTENSIONS as readonly string[]).map((ext) => ({
    id: ext,
    label: ext.toUpperCase(),
    extension: ext === 'jpeg' ? 'jpg' : ext,
    mimeType: imageMimeForExt(ext)
  }))
}
