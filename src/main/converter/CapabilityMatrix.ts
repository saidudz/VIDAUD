import { getFormat } from '@shared/formats'
import type { ConverterCategory, ConverterTarget } from '@shared/types'
import { logger } from '../utils/logger'

/**
 * The Universal Converter capability matrix.
 *
 * Every target below was verified against the actual bundled FFmpeg (essentials
 * build) by running real conversions with the binary. A target only exists here
 * when the backend can genuinely produce it — no container or codec is
 * advertised otherwise. Image targets are FFmpeg's built-in image encoders;
 * video/audio targets reuse the downloader's format registry (muxer + default
 * encoders) which is probed at runtime by FormatManager.
 */

/** Image output targets (verified: png -> each of these succeeds). */
export const IMAGE_TARGETS: ConverterTarget[] = [
  { id: 'jpg', label: 'JPG', kind: 'image', extension: 'jpg', description: 'JPEG image' },
  { id: 'png', label: 'PNG', kind: 'image', extension: 'png', description: 'PNG image' },
  { id: 'webp', label: 'WEBP', kind: 'image', extension: 'webp', description: 'WebP image' },
  { id: 'gif', label: 'GIF', kind: 'image', extension: 'gif', description: 'GIF image' },
  { id: 'bmp', label: 'BMP', kind: 'image', extension: 'bmp', description: 'BMP image' },
  { id: 'tiff', label: 'TIFF', kind: 'image', extension: 'tiff', description: 'TIFF image' },
  { id: 'ico', label: 'ICO', kind: 'image', extension: 'ico', description: 'Windows icon' },
  { id: 'avif', label: 'AVIF', kind: 'image', extension: 'avif', description: 'AV1 image' }
]

/** Video containers whose muxer + default encoders exist in the bundled FFmpeg. */
const VIDEO_TARGET_IDS = [
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v',
  'ts', 'm2ts', 'mts', '3gp', '3g2', 'mpg', 'mpeg', 'vob', 'ogv', 'mxf', 'f4v'
]

/** Audio containers whose muxer + default encoders exist in the bundled FFmpeg. */
const AUDIO_TARGET_IDS = [
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma',
  'aiff', 'alac', 'ac3', 'eac3', 'amr', 'mp2', 'au'
]

function targetsFromIds(ids: string[], kind: 'video' | 'audio'): ConverterTarget[] {
  const out: ConverterTarget[] = []
  for (const id of ids) {
    const f = getFormat(id)
    if (!f) {
      logger.warn(`[VIDAUD][CONVERTER] registry missing format '${id}'`)
      continue
    }
    out.push({ id, label: f.label, kind, extension: f.extension, description: f.label })
  }
  return out
}

export function videoTargets(): ConverterTarget[] {
  return targetsFromIds(VIDEO_TARGET_IDS, 'video')
}

export function audioTargets(): ConverterTarget[] {
  return targetsFromIds(AUDIO_TARGET_IDS, 'audio')
}

/** Document output targets for PDF text/content conversion */
export const DOCUMENT_TARGETS: ConverterTarget[] = [
  { id: 'docx', label: 'DOCX', kind: 'document', extension: 'docx', description: 'Microsoft Word Document', group: 'Document' },
  { id: 'txt', label: 'TXT', kind: 'document', extension: 'txt', description: 'Plain Text Document', group: 'Document' },
  { id: 'html', label: 'HTML', kind: 'document', extension: 'html', description: 'HTML5 Web Document', group: 'Document' },
  { id: 'rtf', label: 'RTF', kind: 'document', extension: 'rtf', description: 'Rich Text Format', group: 'Document' },
  { id: 'md', label: 'MD', kind: 'document', extension: 'md', description: 'Markdown Document', group: 'Document' }
]

export const PDF_IMAGE_TARGETS: ConverterTarget[] = [
  { id: 'png', label: 'PNG', kind: 'image', extension: 'png', description: 'PNG Image (lossless, per page)', group: 'Image' },
  { id: 'jpg', label: 'JPG', kind: 'image', extension: 'jpg', description: 'JPEG Image (per page)', group: 'Image' },
  { id: 'webp', label: 'WEBP', kind: 'image', extension: 'webp', description: 'WebP Image (per page)', group: 'Image' },
  { id: 'tiff', label: 'TIFF', kind: 'image', extension: 'tiff', description: 'TIFF Image (per page)', group: 'Image' },
  { id: 'bmp', label: 'BMP', kind: 'image', extension: 'bmp', description: 'Bitmap Image (per page)', group: 'Image' }
]

export const PDF_TARGETS: ConverterTarget[] = [
  ...PDF_IMAGE_TARGETS,
  ...DOCUMENT_TARGETS
]

export function allTargets(): ConverterTarget[] {
  return [...videoTargets(), ...audioTargets(), ...IMAGE_TARGETS, ...DOCUMENT_TARGETS]
}

export function getConverterTarget(id: string): ConverterTarget | undefined {
  return allTargets().find((t) => t.id === id) || PDF_TARGETS.find((t) => t.id === id)
}

export function isPdfTarget(targetId: string): boolean {
  return PDF_TARGETS.some((t) => t.id === targetId)
}

export function isPdfImageTarget(targetId: string): boolean {
  return PDF_IMAGE_TARGETS.some((t) => t.id === targetId)
}

export function isPdfDocTarget(targetId: string): boolean {
  return DOCUMENT_TARGETS.some((t) => t.id === targetId)
}

/**
 * Classify a lowercased file extension into a converter category.
 * Extensions map 1:1 to demuxers confirmed present in the bundled FFmpeg,
 * except `pdf`, which is handled by the bundled PDF rendering engine.
 */
export function extensionCategory(ext: string): ConverterCategory {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (e in PDF_EXT) return 'pdf'
  if (e in VIDEO_EXT) return 'video'
  if (e in AUDIO_EXT) return 'audio'
  if (e in IMAGE_EXT) return 'image'
  return 'unsupported'
}

const PDF_EXT: Record<string, string> = {
  pdf: 'pdf'
}

const VIDEO_EXT: Record<string, string> = {
  mp4: 'mp4', mkv: 'mkv', webm: 'webm', mov: 'mov', avi: 'avi', wmv: 'wmv',
  flv: 'flv', f4v: 'f4v', m4v: 'm4v', ts: 'ts', mts: 'mts', m2ts: 'm2ts',
  '3gp': '3gp', '3g2': '3g2', mpg: 'mpg', mpeg: 'mpeg', vob: 'vob',
  ogv: 'ogv', mxf: 'mxf', m2v: 'm2v', mka: 'mka'
}

const AUDIO_EXT: Record<string, string> = {
  mp3: 'mp3', m4a: 'm4a', aac: 'aac', wav: 'wav', flac: 'flac', ogg: 'ogg',
  oga: 'oga', opus: 'opus', wma: 'wma', aiff: 'aiff', aif: 'aif', aifc: 'aifc',
  ac3: 'ac3', eac3: 'eac3', amr: 'amr', mp2: 'mp2', au: 'au', snd: 'snd',
  ape: 'ape', tta: 'tta'
}

const IMAGE_EXT: Record<string, string> = {
  jpg: 'jpg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp',
  tiff: 'tiff', tif: 'tif', ico: 'ico', avif: 'avif'
}

export function isKnownImageExt(ext: string): boolean {
  return ext.toLowerCase().replace(/^\./, '') in IMAGE_EXT
}

/**
 * Every extension offered in the native file picker. Broader than what the
 * bundled FFmpeg can convert: documents/archives are listed so the user can
 * pick them, and the backend classifies them honestly as unsupported.
 */
export const PICKER_EXTENSIONS: string[] = [
  // video
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'ts', 'mts', 'm2ts',
  '3gp', '3g2', 'mpg', 'mpeg', 'vob', 'ogv', 'mxf', 'f4v', 'y4m',
  // audio
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif',
  'aifc', 'alac', 'ac3', 'eac3', 'amr', 'mp2', 'au', 'oga', 'ape', 'tta',
  // images
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'svg',
  'avif', 'heic', 'heif',
  // documents
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'html', 'htm', 'md', 'csv',
  'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'epub',
  // archives
  'zip', '7z', 'tar', 'gz', 'bz2', 'xz'
]

/** Extensions the bundled engines can genuinely open and convert. */
const CONVERTIBLE_EXT: Record<string, string> = {
  ...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT, ...PDF_EXT
}

export function isPickerExtension(ext: string): boolean {
  const e = ext.toLowerCase().replace(/^\./, '')
  return e.length > 0 && PICKER_EXTENSIONS.includes(e)
}

export function isConvertibleExtension(ext: string): boolean {
  return ext.toLowerCase().replace(/^\./, '') in CONVERTIBLE_EXT
}
