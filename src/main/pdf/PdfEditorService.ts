/**
 * DEPRECATED: This PDF editor service is no longer used.
 * The dedicated PDF Viewer/Editor feature was removed from VIDAUD.
 * This file is kept for reference only and is not imported anywhere.
 */

export class PdfEditorService {
  async savePdf(_sourcePath: string, _targetPath: string, _state: unknown): Promise<{ ok: boolean; error?: string; outputPath?: string }> {
    return { ok: false, error: 'PDF editor service is deprecated' }
  }

  async splitPdf(_sourcePath: string, _pageRanges: string, _outputDir?: string): Promise<{ ok: boolean; error?: string; outputPaths?: string[] }> {
    return { ok: false, error: 'PDF editor service is deprecated' }
  }
}

