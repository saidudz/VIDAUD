import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { Document, Packer, Paragraph, TextRun, PageBreak, HeadingLevel } from 'docx'
import { resolvePdfWorkerUrl } from '../utils/pdfWorker'
import { buildTextSpans, spansToPlainText } from '../pdf/pdfText'
import { getOcrStatus, recognizePage } from '../pdf/pdfOcr'
import { logger } from '../utils/logger'

export type PdfDocOutputFormat = 'txt' | 'docx' | 'html' | 'rtf' | 'md'

export interface PdfTextConvertOptions {
  /** Cooperative cancellation flag */
  signal?: { aborted: boolean }
  /** Optional document password */
  password?: string
  /** Progress callback */
  onProgress?: (page: number, total: number, message?: string) => void
}

export interface PdfTextConvertResult {
  outputPath: string
  pageCount: number
  totalCharacters: number
  isOcrUsed: boolean
}

/**
 * Escapes characters for HTML5 output.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Escapes Unicode characters into RTF 1.5 standard syntax (\uN?).
 */
function escapeRtf(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 92) { // \
      out += '\\\\'
    } else if (code === 123) { // {
      out += '\\{'
    } else if (code === 125) { // }
      out += '\\}'
    } else if (code === 10) { // \n
      out += '\\line\n'
    } else if (code === 13) {
      // ignore \r
    } else if (code < 128) {
      out += text[i]
    } else {
      // 16-bit signed integer representation for RTF Unicode
      const signedCode = code > 32767 ? code - 65536 : code
      out += `\\u${signedCode}?`
    }
  }
  return out
}

export class PdfTextConverter {
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
    outputPath: string,
    format: PdfDocOutputFormat,
    opts: PdfTextConvertOptions = {}
  ): Promise<PdfTextConvertResult> {
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
        throw new Error('This PDF is password protected.')
      }
      throw new Error('Unable to open this PDF file.')
    }

    const totalPages = doc.numPages
    const pagesText: Array<{ pageNumber: number; text: string }> = []
    let isOcrUsed = false

    try {
      // Pass 1: Extract embedded text layer from every page
      for (let p = 1; p <= totalPages; p++) {
        if (opts.signal?.aborted) {
          throw new Error('PDF conversion was cancelled')
        }

        const page = await doc.getPage(p)
        try {
          const textContent = (await page.getTextContent()) as unknown as {
            items: Array<Record<string, unknown>>
            styles: Record<string, unknown>
            lang: string | null
          }
          const viewport = page.getViewport({ scale: 1 })
          const rd = viewport.rawDims as { pageWidth: number; pageHeight: number; pageX: number; pageY: number }
          const raw = {
            items: textContent.items as unknown as Array<{
              str?: string
              dir?: string
              transform?: number[]
              hasEOL?: boolean
              fontName?: string
              height?: number
            }>,
            styles: textContent.styles as Record<string, { fontFamily: string; vertical: boolean }>,
            lang: textContent.lang
          }
          const spans = buildTextSpans(raw, rd)
          const extracted = spansToPlainText(spans).trim()
          pagesText.push({ pageNumber: p, text: extracted })
        } finally {
          page.cleanup()
        }

        if (opts.onProgress) {
          opts.onProgress(p, totalPages, `Extracting text: page ${p} of ${totalPages}`)
        }
      }

      // Check if document has any embedded text
      const totalChars = pagesText.reduce((sum, item) => sum + item.text.length, 0)

      // Pass 2: Scanned PDF fallback via OCR if no text found
      if (totalChars === 0) {
        const ocrStatus = getOcrStatus()
        if (!ocrStatus.available) {
          throw new Error('Text extraction/OCR is not available for this PDF.')
        }

        isOcrUsed = true
        for (let p = 1; p <= totalPages; p++) {
          if (opts.signal?.aborted) {
            throw new Error('PDF conversion was cancelled')
          }

          if (opts.onProgress) {
            opts.onProgress(p, totalPages, `OCR recognizing: page ${p} of ${totalPages}`)
          }

          const page = await doc.getPage(p)
          try {
            const viewport = page.getViewport({ scale: 2 })
            const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)))
            const ctx = canvas.getContext('2d')
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            await page.render({ canvas: canvas as never, viewport }).promise
            const imgBuffer = canvas.toBuffer('image/png')
            const recognized = (await recognizePage(imgBuffer)).text.trim()
            pagesText[p - 1].text = recognized
          } finally {
            page.cleanup()
          }
        }
      }

      const finalCharCount = pagesText.reduce((sum, item) => sum + item.text.length, 0)
      if (finalCharCount === 0) {
        throw new Error('No text could be extracted from this PDF.')
      }

      const docTitle = basename(input)

      // Write output in requested format
      switch (format) {
        case 'txt': {
          let fullText = ''
          for (const item of pagesText) {
            if (totalPages > 1) {
              fullText += `--- Page ${item.pageNumber} ---\n\n`
            }
            fullText += `${item.text}\n\n`
          }
          writeFileSync(outputPath, fullText.trim() + '\n', 'utf8')
          break
        }

        case 'md': {
          let md = `# ${docTitle}\n\n`
          for (const item of pagesText) {
            if (totalPages > 1) {
              md += `## Page ${item.pageNumber}\n\n`
            }
            md += `${item.text}\n\n`
            if (totalPages > 1 && item.pageNumber < totalPages) {
              md += `---\n\n`
            }
          }
          writeFileSync(outputPath, md.trim() + '\n', 'utf8')
          break
        }

        case 'html': {
          let body = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>${escapeHtml(docTitle)}</title>\n  <style>\n    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #222; max-width: 800px; margin: 40px auto; padding: 0 20px; background: #fafafa; }\n    .page { background: #fff; border-radius: 8px; padding: 40px; margin-bottom: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.06); }\n    .page-header { font-size: 0.85em; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 8px; }\n    p { margin-bottom: 1em; white-space: pre-wrap; word-break: break-word; }\n  </style>\n</head>\n<body>\n`
          for (const item of pagesText) {
            body += `  <div class="page">\n`
            if (totalPages > 1) {
              body += `    <div class="page-header">Page ${item.pageNumber}</div>\n`
            }
            const paragraphs = item.text.split(/\n\s*\n/)
            for (const p of paragraphs) {
              if (p.trim().length > 0) {
                body += `    <p>${escapeHtml(p.trim())}</p>\n`
              }
            }
            body += `  </div>\n`
          }
          body += `</body>\n</html>\n`
          writeFileSync(outputPath, body, 'utf8')
          break
        }

        case 'docx': {
          const docSections: Paragraph[] = []
          for (let idx = 0; idx < pagesText.length; idx++) {
            const item = pagesText[idx]
            if (totalPages > 1) {
              docSections.push(
                new Paragraph({
                  text: `Page ${item.pageNumber}`,
                  heading: HeadingLevel.HEADING_2,
                  spacing: { before: 200, after: 120 }
                })
              )
            }
            const paragraphs = item.text.split(/\n\s*\n/)
            for (const p of paragraphs) {
              if (p.trim().length > 0) {
                docSections.push(
                  new Paragraph({
                    children: [new TextRun({ text: p.trim(), size: 24 })],
                    spacing: { after: 160 }
                  })
                )
              }
            }
            if (idx < pagesText.length - 1) {
              docSections.push(new Paragraph({ children: [new PageBreak()] }))
            }
          }

          const wordDoc = new Document({
            title: docTitle,
            sections: [{ properties: {}, children: docSections }]
          })

          const buffer = await Packer.toBuffer(wordDoc)
          writeFileSync(outputPath, buffer)
          break
        }

        case 'rtf': {
          let rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033\n'
          rtf += '{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}{\\f1\\fnil\\fcharset178 Arial;}}\n'
          rtf += '{\\colortbl ;\\red0\\green0\\blue0;\\red120\\green120\\blue120;}\n'
          rtf += '\\viewkind4\\uc1\\pard\\sa200\\sl276\\slmult1\\f0\\fs22\n'

          for (let idx = 0; idx < pagesText.length; idx++) {
            const item = pagesText[idx]
            if (totalPages > 1) {
              rtf += `{\\b\\fs26\\cf2 Page ${item.pageNumber}}\\par\\par\n`
            }
            const escaped = escapeRtf(item.text)
            rtf += `${escaped}\\par\n`
            if (idx < pagesText.length - 1) {
              rtf += '\\page\n'
            }
          }

          rtf += '}\n'
          writeFileSync(outputPath, rtf, 'ascii')
          break
        }
      }

      logger.info(`[VIDAUD][PDF] ${input} -> ${outputPath} (${format.toUpperCase()}, ${totalPages} pages, ${finalCharCount} chars) OK`)

      return {
        outputPath,
        pageCount: totalPages,
        totalCharacters: finalCharCount,
        isOcrUsed
      }
    } finally {
      await loadingTask.destroy().catch(() => undefined)
    }
  }
}
