/**
 * Normalize a codec string from yt-dlp / ffmpeg into a canonical name we use in
 * the format registry. yt-dlp reports tags like `av01.0.05M.08`, `vp09`,
 * `mp4a.40.2`, `ac-3`, `ec-3` while ffmpeg reports `av1`, `vp9`, `aac`, `ac3`.
 */
export function normalizeCodec(codec: string | undefined): string {
  if (!codec) return ''
  const c = String(codec).toLowerCase()
  if (c.includes('av01')) return 'av1'
  if (c.includes('vp09') || c === 'vp9') return 'vp9'
  if (c.includes('vp8')) return 'vp8'
  if (c === 'avc1' || c.includes('h264') || c.includes('x264')) return 'h264'
  if (c === 'h265' || c === 'hvc1' || c === 'hev1' || c.includes('hevc') || c.includes('x265')) return 'hevc'
  if (c.includes('mp4a') || c === 'aac') return 'aac'
  if (c === 'ac-3' || c === 'ac3' || c.includes('ac-3')) return 'ac3'
  if (c === 'ec-3' || c === 'eac3' || c.includes('ec-3')) return 'eac3'
  if (c.includes('msmpeg4v3') || c.includes('wmv3')) return 'wmv3'
  if (c.includes('msmpeg4v2')) return 'msmpeg4v2'
  if (c.includes('amr') && c.includes('nb')) return 'amr_nb'
  if (c.includes('mp3')) return 'mp3'
  return c
}

/**
 * Map a codec/format id (as stored in the registry or picked in the UI) to the
 * actual FFmpeg encoder name. Codec ids like `mp3`, `opus`, `vorbis`, `theora`,
 * `av1`, `vp9`, `h264` differ from the encoder executables
 * (`libmp3lame`, `libopus`, `libvorbis`, `libtheora`, `libaom-av1`, ...).
 */
export function normalizeEncoder(codec: string | undefined): string {
  if (!codec) return ''
  const c = String(codec).toLowerCase()
  switch (c) {
    case 'mp3':
      return 'libmp3lame'
    case 'opus':
      return 'libopus'
    case 'vorbis':
      return 'libvorbis'
    case 'theora':
      return 'libtheora'
    case 'av1':
      return 'libaom-av1'
    case 'vp9':
      return 'libvpx-vp9'
    case 'vp8':
      return 'libvpx'
    case 'h264':
      return 'libx264'
    case 'hevc':
      return 'libx265'
    case 'amr':
    case 'amr_nb':
      return 'libopencore_amrnb'
    case 'pcm':
    case 'wav':
    case 'lpcm':
      return 'pcm_s16le'
    default:
      return c
  }
}
