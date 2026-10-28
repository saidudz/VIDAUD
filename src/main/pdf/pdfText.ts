/**
 * PDF text layer math, replicated from pdf.js's TextLayer builder so the
 * spans line up pixel-perfectly with the rendered page image.
 * We compute every span's position as percentages of the page (left/top)
 * plus its font height in PDF points — all scale independent.
 */

export interface PdfTextSpan {
  str: string
  dir: 'ltr' | 'rtl' | 'ttb' | 'auto'
  hasEOL: boolean
  leftPct: number
  topPct: number
  fontPt: number
  angle: number
}

export interface PdfPageText {
  mode: 'text' | 'ocr' | 'none'
  spans: PdfTextSpan[]
  plainText: string
  ocr?: boolean
}

/** Multiply two 2D affine matrices (m1 then m2), same as pdf.js Util.transform. */
function mul(m1: number[], m2: number[]): number[] {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ]
}

interface RawDims {
  pageWidth: number
  pageHeight: number
  pageX: number
  pageY: number
}

interface TextStyle {
  fontFamily: string
  ascent?: number
  descent?: number
  vertical: boolean
}

interface TextItem {
  str?: string
  dir?: string
  transform?: number[]
  hasEOL?: boolean
  fontName?: string
  height?: number
}

interface TextContent {
  items: TextItem[]
  styles: Record<string, TextStyle>
  lang: string | null
}

/**
 * Extract selectable/searchable spans for one page, matching pdf.js's
 * TextLayer positioning. `viewportRawDims` must come from
 * `page.getViewport({ scale: 1 }).rawDims` so the transform maps user space
 * (origin bottom-left) to the rotated viewport (origin top-left).
 */
export function buildTextSpans(textContent: TextContent, rawDims: RawDims): PdfTextSpan[] {
  const { pageWidth, pageHeight, pageX, pageY } = rawDims
  // Same transform pdf.js TextLayer uses to go from user space to viewport space.
  const viewportTransform = [1, 0, 0, -1, -pageX, pageY + pageHeight]
  const spans: PdfTextSpan[] = []

  for (const item of textContent.items) {
    const str = item.str
    if (str === undefined || !item.transform) continue
    const style = textContent.styles[item.fontName ?? ''] ?? { fontFamily: 'sans-serif', vertical: false }
    const tx = mul(viewportTransform, item.transform)

    let angle = Math.atan2(tx[1], tx[0])
    if (style.vertical) angle += Math.PI / 2

    const fontPt = Math.hypot(tx[2], tx[3])
    if (fontPt <= 0) continue

    // pdf.js falls back to style.ascent / (1 + style.descent) / 0.8 when it
    // cannot measure the real font; we use the same rules.
    let ascentRatio = 0.8
    if (typeof style.ascent === 'number') ascentRatio = style.ascent
    else if (typeof style.descent === 'number') ascentRatio = 1 + style.descent
    const ascent = fontPt * ascentRatio

    let left: number
    let top: number
    if (angle === 0) {
      left = tx[4]
      top = tx[5] - ascent
    } else {
      left = tx[4] + ascent * Math.sin(angle)
      top = tx[5] - ascent * Math.cos(angle)
    }

    const dir = item.dir === 'rtl' || item.dir === 'ttb' ? item.dir : 'ltr'
    spans.push({
      str,
      dir,
      hasEOL: !!item.hasEOL,
      leftPct: round2((100 * left) / pageWidth),
      topPct: round2((100 * top) / pageHeight),
      fontPt: round2(fontPt),
      angle: Math.round(angle * (180 / Math.PI) * 10) / 10
    })
  }

  return spans
}

/** Build plain text (line breaks preserved) for search + copy. */
export function spansToPlainText(spans: PdfTextSpan[]): string {
  let out = ''
  for (const s of spans) {
    out += s.str
    if (s.hasEOL) out += '\n'
  }
  return out
}

export function emptyPageText(): PdfPageText {
  return { mode: 'none', spans: [], plainText: '', ocr: false }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const ARABIC_RE = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/
const LATIN_RE = /[a-zA-Z\u00c0-\u024f\u1e00-\u1eff]/
// Characters that are near-exclusive to French (accents + ligatures).
const FRENCH_RE = /[àâçéèêëîïôùûüÿœæÀÂÇÉÈÊËÎÏÔÙÛÜŸŒÆ]/

/**
 * Detect the dominant language from extracted text. Returns
 * 'ar' | 'en' | 'fr' | 'mixed' | 'unknown'.
 */
export function detectLanguage(samples: string[]): string {
  let arabic = 0
  let latin = 0
  let french = 0

  for (const sample of samples) {
    for (const ch of sample) {
      if (ARABIC_RE.test(ch)) arabic++
      else if (LATIN_RE.test(ch)) {
        latin++
        if (FRENCH_RE.test(ch)) french++
      }
    }
  }

  const total = arabic + latin
  if (total === 0) return 'unknown'
  const arRatio = arabic / total
  const laRatio = latin / total

  if (arRatio > 0.5) return 'ar'
  if (laRatio > 0.5) {
    // Latin script: distinguish French from English by diacritic density.
    return latin > 40 && french / latin > 0.03 ? 'fr' : 'en'
  }
  if (arabic > 0 && latin > 0) return 'mixed'
  return 'unknown'
}
