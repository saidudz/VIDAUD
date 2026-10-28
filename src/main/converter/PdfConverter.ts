import { readFileSync, writeFileSync } from 'node:fs'
import { join, parse as parsePath } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolvePdfWorkerUrl } from '../utils/pdfWorker'
import { logger } from '../utils/logger'

export type PdfImageOutputFormat = 'png' | 'jpg' | 'webp' | 'tiff' | 'bmp'

export interface PdfConvertOptions {
  /** Called after each page is rendered. Page numbers are 1-based. */
  onPage?: (page: number, total: number, message?: string) => void
  /** Cooperative cancellation flag, checked between pages. */
  signal?: { aborted: boolean }
  /** Output image quality 1-100 (for JPG and WEBP). Default: 90 */
  quality?: number
  /** Rendering DPI (e.g. 72, 96, 150, 200, 300, 600). Default: 150 (scale = dpi / 72) */
  dpi?: number
  /** Page range mode: 'all' or 'range' */
  pageRangeMode?: 'all' | 'range'
  /** 1-based start page */
  pageRangeStart?: number
  /** 1-based end page */
  pageRangeEnd?: number
  /** Optional document password */
  password?: string
  /** Base name used for the `document-001.png` file prefix (default: 'document'). */
  baseName?: string
}

export interface PdfConvertResult {
  pageCount: number
  renderedCount: number
  outputPaths: string[]
  outputDir: string
}

/**
 * Creates a valid 24-bit uncompressed Windows BMP buffer from RGBA pixels.
 */
function createBmpBuffer(width: number, height: number, rgba: Uint8ClampedArray, dpi = 150): Buffer {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4
  const pixelArraySize = rowSize * height
  const fileSize = 54 + pixelArraySize
  const buf = Buffer.alloc(fileSize)

  // BITMAPFILEHEADER (14 bytes)
  buf.write('BM', 0) // Signature
  buf.writeUInt32LE(fileSize, 2) // Total file size
  buf.writeUInt32LE(0, 6) // Reserved
  buf.writeUInt32LE(54, 10) // Offset to pixel data

  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, 14) // Header size
  buf.writeInt32LE(width, 18) // Width
  buf.writeInt32LE(height, 22) // Height (positive = bottom-to-top)
  buf.writeUInt16LE(1, 26) // Color planes
  buf.writeUInt16LE(24, 28) // Bits per pixel
  buf.writeUInt32LE(0, 30) // Compression (BI_RGB = none)
  buf.writeUInt32LE(pixelArraySize, 34) // Image size
  const ppm = Math.round(dpi * 39.3701) // Pixels per meter
  buf.writeInt32LE(ppm, 38) // X pixels per meter
  buf.writeInt32LE(ppm, 42) // Y pixels per meter
  buf.writeUInt32LE(0, 46) // Colors used
  buf.writeUInt32LE(0, 50) // Important colors

  // Pixels stored bottom-to-top, BGR order
  let pos = 54
  for (let y = height - 1; y >= 0; y--) {
    const rowStart = pos
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      buf[pos++] = rgba[idx + 2] // Blue
      buf[pos++] = rgba[idx + 1] // Green
      buf[pos++] = rgba[idx] // Red
    }
    // Padding to 4-byte boundary
    while (pos < rowStart + rowSize) {
      buf[pos++] = 0
    }
  }

  return buf
}

/**
 * Creates a valid Baseline TIFF 6.0 uncompressed RGB buffer from RGBA pixels.
 */
function createTiffBuffer(width: number, height: number, rgba: Uint8ClampedArray, dpi = 150): Buffer {
  const numTags = 12
  const headerSize = 8
  const ifdSize = 2 + numTags * 12 + 4
  const valuesOffset = headerSize + ifdSize
  const valuesSize = 6 + 8 + 8 // BitsPerSample(6) + XRes(8) + YRes(8)
  const pixelDataOffset = valuesOffset + valuesSize
  const pixelDataSize = width * height * 3
  const totalSize = pixelDataOffset + pixelDataSize

  const buf = Buffer.alloc(totalSize)

  // Header: Little-Endian 'II'
  buf.write('II', 0)
  buf.writeUInt16LE(42, 2)
  buf.writeUInt32LE(headerSize, 4) // Offset to 0th IFD

  let pos = headerSize
  buf.writeUInt16LE(numTags, pos)
  pos += 2

  function writeTag(tag: number, type: number, count: number, valOrOff: number): void {
    buf.writeUInt16LE(tag, pos)
    buf.writeUInt16LE(type, pos + 2)
    buf.writeUInt32LE(count, pos + 4)
    buf.writeUInt32LE(valOrOff, pos + 8)
    pos += 12
  }

  const bitsPerSampleOff = valuesOffset
  const xResOff = valuesOffset + 6
  const yResOff = valuesOffset + 14

  writeTag(256, 4, 1, width) // ImageWidth (LONG)
  writeTag(257, 4, 1, height) // ImageLength (LONG)
  writeTag(258, 3, 3, bitsPerSampleOff) // BitsPerSample -> [8,8,8]
  writeTag(259, 3, 1, 1) // Compression: 1 = None
  writeTag(262, 3, 1, 2) // PhotometricInterpretation: 2 = RGB
  writeTag(273, 4, 1, pixelDataOffset) // StripOffsets
  writeTag(277, 3, 1, 3) // SamplesPerPixel
  writeTag(278, 4, 1, height) // RowsPerStrip
  writeTag(279, 4, 1, pixelDataSize) // StripByteCounts
  writeTag(282, 5, 1, xResOff) // XResolution
  writeTag(283, 5, 1, yResOff) // YResolution
  writeTag(296, 3, 1, 2) // ResolutionUnit: 2 = Inch

  buf.writeUInt32LE(0, pos) // Next IFD offset (0 = none)

  // Values Block
  buf.writeUInt16LE(8, bitsPerSampleOff)
  buf.writeUInt16LE(8, bitsPerSampleOff + 2)
  buf.writeUInt16LE(8, bitsPerSampleOff + 4)

  buf.writeUInt32LE(dpi, xResOff)
  buf.writeUInt32LE(1, xResOff + 4)

  buf.writeUInt32LE(dpi, yResOff)
  buf.writeUInt32LE(1, yResOff + 4)

  // Pixel Data: RGB top-to-bottom
  let pPos = pixelDataOffset
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4
    buf[pPos++] = rgba[idx] // R
    buf[pPos++] = rgba[idx + 1] // G
    buf[pPos++] = rgba[idx + 2] // B
  }

  return buf
}

/**
 * Renders a PDF into raster images (PNG, JPG, WEBP, TIFF, BMP) per page using
 * pdfjs-dist and @napi-rs/canvas.
 */
export class PdfConverter {
  private workerConfigured = false

  private configureWorker(): void {
    if (this.workerConfigured) return
    const url = resolvePdfWorkerUrl()
    if (!url) {
      throw new Error('PDF rendering engine (pdf.worker.mjs) is not bundled. Please reinstall VIDAUD.')
    }
    pdfjs.GlobalWorkerOptions.workerSrc = url
    this.workerConfigured = true
  }

  async convert(
    input: string,
    outDir: string,
    format: PdfImageOutputFormat,
    opts: PdfConvertOptions = {}
  ): Promise<PdfConvertResult> {
    this.configureWorker()

    const data = new Uint8Array(readFileSync(input))
    const loadingTask = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      password: opts.password || undefined
    })

    let doc: pdfjs.PDFDocumentProxy
    try {
      doc = await loadingTask.promise
    } catch (e: unknown) {
      await loadingTask.destroy().catch(() => undefined)
      const name = (e as { name?: string })?.name || ''
      if (name === 'PasswordException' || /password/i.test(String(e))) {
        throw new PdfPasswordError('This PDF is password protected.')
      }
      throw new PdfInvalidError('Unable to open this PDF file.')
    }

    const total = doc.numPages
    const base = opts.baseName || 'document'
    const outputPaths: string[] = []

    // Calculate DPI scale factor: standard PDF unit is 72 pt/inch
    const dpi = Math.min(600, Math.max(72, opts.dpi || 150))
    const scale = dpi / 72

    // Determine page range
    let startPage = 1
    let endPage = total
    if (opts.pageRangeMode === 'range') {
      if (opts.pageRangeStart && opts.pageRangeStart >= 1) {
        startPage = Math.min(total, Math.max(1, Math.floor(opts.pageRangeStart)))
      }
      if (opts.pageRangeEnd && opts.pageRangeEnd >= startPage) {
        endPage = Math.min(total, Math.floor(opts.pageRangeEnd))
      }
    }

    const targetPages: number[] = []
    for (let p = startPage; p <= endPage; p++) {
      targetPages.push(p)
    }

    // Number of digits for zero-padding (at least 3 digits: 001, 002... or 0001 for 1000+ pages)
    const padLength = Math.max(3, String(total).length)

    try {
      for (let idx = 0; idx < targetPages.length; idx++) {
        if (opts.signal?.aborted) {
          throw new PdfAbortError('PDF conversion was cancelled')
        }

        const pageNum = targetPages[idx]
        const page = await doc.getPage(pageNum)

        try {
          const viewport = page.getViewport({ scale })
          const width = Math.max(1, Math.floor(viewport.width))
          const height = Math.max(1, Math.floor(viewport.height))
          const canvas = createCanvas(width, height)
          const ctx = canvas.getContext('2d')

          // For JPG, BMP, TIFF: draw white background so there's no dark transparency artifact
          if (format === 'jpg' || format === 'bmp' || format === 'tiff') {
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, width, height)
          }

          await page.render({ canvas: canvas as never, viewport }).promise

          const pageNumStr = String(pageNum).padStart(padLength, '0')
          const ext = format.toLowerCase()
          const outPath = join(outDir, `${base}-${pageNumStr}.${ext}`)

          const quality = Math.min(100, Math.max(1, opts.quality ?? 90))

          switch (format) {
            case 'jpg':
              writeFileSync(outPath, canvas.toBuffer('image/jpeg', quality))
              break
            case 'webp':
              writeFileSync(outPath, canvas.toBuffer('image/webp', quality))
              break
            case 'bmp': {
              const imgData = ctx.getImageData(0, 0, width, height)
              writeFileSync(outPath, createBmpBuffer(width, height, imgData.data, dpi))
              break
            }
            case 'tiff': {
              const imgData = ctx.getImageData(0, 0, width, height)
              writeFileSync(outPath, createTiffBuffer(width, height, imgData.data, dpi))
              break
            }
            case 'png':
            default:
              writeFileSync(outPath, canvas.toBuffer('image/png'))
              break
          }

          outputPaths.push(outPath)
        } finally {
          page.cleanup()
        }

        if (opts.onPage) {
          const done = idx + 1
          opts.onPage(done, targetPages.length, `Rendering page ${done} of ${targetPages.length}`)
        }
      }
    } finally {
      await loadingTask.destroy()
    }

    logger.info(`[VIDAUD][PDF] ${input} -> ${outputPaths.length} ${format.toUpperCase()} page(s) in ${outDir}`)
    return {
      pageCount: total,
      renderedCount: outputPaths.length,
      outputPaths,
      outputDir: outDir
    }
  }
}

export class PdfAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfAbortError'
  }
}

export class PdfPasswordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfPasswordError'
  }
}

export class PdfInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfInvalidError'
  }
}

/** Sanitized stem used as the per-page file prefix, e.g. My Document-001.png. */
export function pdfPagePrefix(inputName: string): string {
  const name = parsePath(inputName).name.trim()
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim() || 'document'
}
