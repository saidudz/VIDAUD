/**
 * DEPRECATED: This PDF viewer service is no longer used.
 * The Universal Converter uses pdfjs-dist directly for PDF processing.
 * This file is kept for reference only and is not imported anywhere.
 */

export class PdfError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PdfError'
    this.code = code
  }
}

export class PdfService {
  dispose(): Promise<void> {
    return Promise.resolve()
  }
}
