/**
 * Pure clipboard-text helpers shared by main and renderer.
 * No Electron/Node imports here so the module stays importable everywhere.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi

/** Trailing characters that are sentence punctuation, not part of the URL. */
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

/**
 * Extracts every http(s) URL from arbitrary clipboard text, in order of
 * appearance, deduplicated. Long URLs (query strings, hashes) are preserved
 * in full — only surrounding whitespace and trailing sentence punctuation
 * are removed, never valid URL characters (? & = # / : % etc.).
 */
export function findUrlsInText(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  // Cap the scan so a pathological multi-MB paste cannot stall the UI.
  const matches = text.slice(0, 100000).match(URL_PATTERN) ?? []
  for (const raw of matches.slice(0, 20)) {
    const cleaned = raw.replace(TRAILING_PUNCT, '')
    if (cleaned.length > 0 && !seen.has(cleaned)) {
      seen.add(cleaned)
      out.push(cleaned)
    }
  }
  return out
}
