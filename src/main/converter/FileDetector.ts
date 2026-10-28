import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ConverterTarget, DetectedFile } from '@shared/types'
import { FfmpegManager } from '../ffmpeg/FfmpegManager'
import { audioTargets, extensionCategory, IMAGE_TARGETS, PDF_TARGETS, videoTargets } from './CapabilityMatrix'
import { resolvePdfWorkerUrl } from '../utils/pdfWorker'
import { logger } from '../utils/logger'

/** Categories that are recognized but have no bundled engine (honest "unsupported"). */
const UNSUPPORTED_REASON: Record<string, string> = {
  doc: 'Document conversion engine is not bundled',
  docx: 'Document conversion engine is not bundled',
  xls: 'Document conversion engine is not bundled',
  xlsx: 'Document conversion engine is not bundled',
  ppt: 'Document conversion engine is not bundled',
  pptx: 'Document conversion engine is not bundled',
  odt: 'Document conversion engine is not bundled',
  ods: 'Document conversion engine is not bundled',
  odp: 'Document conversion engine is not bundled',
  rtf: 'Document conversion engine is not bundled',
  txt: 'Text conversion engine is not bundled',
  epub: 'E-book conversion engine is not bundled',
  zip: 'Archive tool is not bundled',
  rar: 'Archive tool is not bundled',
  '7z': 'Archive tool is not bundled',
  tar: 'Archive tool is not bundled',
  gz: 'Archive tool is not bundled',
  bz2: 'Archive tool is not bundled',
  xz: 'Archive tool is not bundled',
  heic: 'HEIC decoder is not available in the bundled FFmpeg',
  heif: 'HEIF decoder is not available in the bundled FFmpeg',
  svg: 'SVG decoder is not available in the bundled FFmpeg',
  psd: 'Photoshop decoder is not available',
  dng: 'Camera RAW decoder is not available',
  cr2: 'Camera RAW decoder is not available',
  nef: 'Camera RAW decoder is not available',
  arw: 'Camera RAW decoder is not available'
}

/** True when the file starts with the PDF magic marker `%PDF-`. */
function hasPdfMagic(path: string): boolean {
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(1024)
      const n = readSync(fd, buf, 0, buf.length, 0)
      return n > 0 && buf.subarray(0, n).includes(Buffer.from('%PDF-'))
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

export class FileDetector {
  private ffmpeg: FfmpegManager

  constructor(ffmpeg: FfmpegManager) {
    this.ffmpeg = ffmpeg
  }

  private targetsFor(category: 'video' | 'audio' | 'image' | 'pdf'): ConverterTarget[] {
    if (category === 'video') return [...videoTargets(), ...audioTargets()]
    if (category === 'audio') return audioTargets()
    if (category === 'pdf') return PDF_TARGETS
    return IMAGE_TARGETS
  }

  async detect(path: string): Promise<DetectedFile> {
    const name = basename(path)
    const ext = extname(path).slice(1).toLowerCase()
    const base: DetectedFile = {
      path,
      name,
      size: 0,
      category: extensionCategory(ext),
      extension: ext || 'unknown',
      targets: []
    }
    try {
      const st = statSync(path)
      base.size = st.size
    } catch {
      base.category = 'unsupported'
      base.unsupportedReason = 'File is not readable on disk'
      return base
    }
    if (base.size <= 0) {
      base.category = 'unsupported'
      base.unsupportedReason = 'File is empty'
      return base
    }
    if (base.category === 'unsupported') {
      base.unsupportedReason = UNSUPPORTED_REASON[ext] ?? 'This file type is not supported for conversion'
      return base
    }

    // PDFs are processed by the bundled PDF engine. A magic-byte check
    // followed by lightweight metadata parsing reads page count and dimensions.
    if (base.category === 'pdf') {
      if (!hasPdfMagic(path)) {
        base.category = 'unsupported'
        base.unsupportedReason = 'This file is not a valid PDF document'
        return base
      }
      try {
        const workerUrl = resolvePdfWorkerUrl()
        if (workerUrl) {
          pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        }
        const data = new Uint8Array(readFileSync(path))
        const task = pdfjs.getDocument({ data, useSystemFonts: true })
        const doc = await task.promise
        base.pageCount = doc.numPages
        try {
          const page1 = await doc.getPage(1)
          const vp = page1.getViewport({ scale: 1 })
          base.width = Math.round(vp.width)
          base.height = Math.round(vp.height)
          page1.cleanup()
        } catch {
          // ignore first page dimension error
        }
        await task.destroy()
        base.probed = true
      } catch (e: unknown) {
        const name = (e as { name?: string })?.name || ''
        if (name === 'PasswordException' || /password/i.test(String(e))) {
          base.probed = true
          base.pageCount = 1
        } else {
          logger.warn(`[VIDAUD][CONVERTER] pdf metadata read failed for ${path}: ${e}`)
        }
      }
      base.targets = this.targetsFor('pdf')
      return base
    }

    // Real content check for media/images: stream info, dimensions, duration.
    const probe = await this.ffmpeg.probe(path)
    if (probe.hasVideo || probe.hasAudio || probe.streams.length > 0) {
      base.probed = true
      base.hasVideo = probe.hasVideo
      base.hasAudio = probe.hasAudio
      if (probe.width && probe.height) {
        base.width = probe.width
        base.height = probe.height
      }
      if (probe.duration && probe.duration > 0) base.duration = probe.duration
    } else if (base.category !== 'image') {
      // A media-looking extension that FFmpeg could not open.
      base.category = 'unsupported'
      base.unsupportedReason = 'FFmpeg could not read this file (corrupt or unsupported variant)'
      return base
    }

    base.targets = this.targetsFor(base.category as 'video' | 'audio' | 'image')
    return base
  }

  async detectMany(paths: string[], onProgress?: (done: number, total: number) => void): Promise<DetectedFile[]> {
    const results: DetectedFile[] = []
    for (const p of paths) {
      try {
        results.push(await this.detect(p))
      } catch (e) {
        logger.warn(`[VIDAUD][CONVERTER] detect failed for ${p}: ${e}`)
        results.push({
          path: p,
          name: basename(p),
          size: 0,
          category: 'unsupported',
          extension: extname(p).slice(1).toLowerCase(),
          unsupportedReason: 'Detection failed',
          targets: []
        })
      }
      if (onProgress) onProgress(results.length, paths.length)
    }
    return results
  }
}
