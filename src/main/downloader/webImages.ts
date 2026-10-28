import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { URL } from 'node:url'
import { logger } from '../utils/logger'
import { DownloadFailure } from './errors'
import { IMAGE_URL_EXTS } from './image'

// Google Images uses various data structures embedded in the HTML.
// The main one is AF_initDataCallback with a base64-encoded payload.
// We decode and parse it to extract image results.
interface GoogleImageResult {
  thumbnail: string
  original: string
  sourcePage: string
  title: string
  width: number
  height: number
}

interface GoogleExtractedImage extends ExtractedImage {
  thumbnail?: string
  originalUrl?: string
  sourcePageUrl?: string
  source?: string
  originalAvailable?: boolean
}

function decodeGoogleImagesData(html: string): GoogleImageResult[] {
  const results: GoogleImageResult[] = []

  // Try to find AF_initDataCallback calls with the image data (key 'ds:1' or similar)
  // Pattern: AF_initDataCallback([...data...])
  const afRe = /AF_initDataCallback\((\[[\s\S]*?\])\s*\)/g
  let match: RegExpExecArray | null
  while ((match = afRe.exec(html)) !== null) {
    try {
      const payload = match[1]
      // The payload is a JSON array. The image data is typically in a nested structure.
      // We look for arrays containing image URLs and metadata.
      const data = JSON.parse(payload)
      // Recursively search for image result structures
      const found = extractFromGoogleData(data)
      if (found.length > 0) {
        results.push(...found)
        // If we found results in this payload, we can stop (first match is usually the main one)
        if (results.length > 0) break
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Also try to find JSON-LD structured data for images
  const ldRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]{0,500000}?)<\/script>/gi
  let ld: RegExpExecArray | null
  while ((ld = ldRe.exec(html)) !== null) {
    try {
      const body = ld[1].trim()
      const json = JSON.parse(body)
      const found = extractFromJsonLd(json)
      if (found.length > 0) results.push(...found)
    } catch {
      // Ignore
    }
  }

  // Deduplicate by original URL
  const seen = new Set<string>()
  const unique = results.filter(r => {
    const key = r.original || r.thumbnail
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return unique
}

function extractFromGoogleData(data: unknown): Array<{ thumbnail: string; original: string; sourcePage: string; title: string; width: number; height: number }> {
  const results: Array<{ thumbnail: string; original: string; sourcePage: string; title: string; width: number; height: number }> = []

  function walk(obj: unknown, path: string[] = []): void {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      // Check if this array looks like an image result entry
      // Google Images entries often have: [id, [thumbnailUrl, width, height], [originalUrl, width, height], sourcePage, title, ...]
      if (obj.length >= 5 && typeof obj[0] === 'string' && Array.isArray(obj[1]) && Array.isArray(obj[2])) {
        const thumbArr = obj[1]
        const origArr = obj[2]
        const sourcePage = typeof obj[3] === 'string' ? obj[3] : ''
        const title = typeof obj[4] === 'string' ? obj[4] : ''
        if (typeof thumbArr[0] === 'string' && thumbArr[0].startsWith('http')) {
          const thumbnail = thumbArr[0]
          const tw = typeof thumbArr[1] === 'number' ? thumbArr[1] : undefined
          const th = typeof thumbArr[2] === 'number' ? thumbArr[2] : undefined
          const original = typeof origArr[0] === 'string' && origArr[0].startsWith('http') ? origArr[0] : thumbnail
          const ow = typeof origArr[1] === 'number' ? origArr[1] : tw
          const oh = typeof origArr[2] === 'number' ? origArr[2] : th
          results.push({
            thumbnail,
            original,
            sourcePage,
            title: title || 'Google Image',
            width: ow ?? tw ?? 0,
            height: oh ?? th ?? 0
          })
        }
      }
      obj.forEach((item, i) => walk(item, [...path, String(i)]))
    } else {
      Object.entries(obj).forEach(([k, v]) => walk(v, [...path, k]))
    }
  }

  walk(data)
  return results
}

function extractFromJsonLd(json: unknown): Array<{ thumbnail: string; original: string; sourcePage: string; title: string; width: number; height: number }> {
  const results: Array<{ thumbnail: string; original: string; sourcePage: string; title: string; width: number; height: number }> = []

  function walk(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      obj.forEach(walk)
    } else {
      const o = obj as Record<string, unknown>
      // Look for ImageObject or similar structured data
      if (o['@type'] === 'ImageObject' || (Array.isArray(o['@type']) && o['@type'].includes('ImageObject'))) {
        const contentUrl = typeof o.contentUrl === 'string' ? o.contentUrl : ''
        const thumbnailUrl = typeof o.thumbnailUrl === 'string' ? o.thumbnailUrl : ''
        const caption = typeof o.caption === 'string' ? o.caption : ''
        const width = typeof o.width === 'number' ? o.width : (typeof o.width === 'string' ? Number(o.width) : 0)
        const height = typeof o.height === 'number' ? o.height : (typeof o.height === 'string' ? Number(o.height) : 0)
        if (contentUrl || thumbnailUrl) {
          results.push({
            thumbnail: thumbnailUrl || contentUrl,
            original: contentUrl || thumbnailUrl,
            sourcePage: '',
            title: caption || 'Image',
            width,
            height
          })
        }
      }
      Object.values(o).forEach(walk)
    }
  }

  walk(json)
  return results
}

// Fallback: extract from static <img> tags and other markup (used for non-Google pages)
function extractFromMarkup(html: string, baseUrl: string, pageTitle: string): { images: ExtractedImage[]; excluded: number } {
  // This is the existing extractImageUrls logic, moved here for reuse
  const seen = new Map<string, ExtractedImage>()
  const excludedKeys = new Set<string>()
  let excluded = 0
  let n = 0

  const push = (raw: string | null | undefined, opts?: { alt?: string | null; width?: number; height?: number; decorative?: boolean }): void => {
    if (!raw) return
    const src = raw.trim()
    if (!src || src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('javascript:') || src.startsWith('about:')) return
    let abs: string
    try {
      abs = new URL(src, baseUrl).toString()
    } catch {
      return
    }
    if (!abs.startsWith('http://') && !abs.startsWith('https://')) return
    const key = canonicalKey(abs)
    if (seen.has(key) || excludedKeys.has(key)) return
    const low = abs.toLowerCase()
    if (low.endsWith('.ico') || low.includes('/favicon') || low.includes('apple-touch-icon')) {
      excludedKeys.add(key)
      excluded += 1
      return
    }
    if (opts?.width === 1 && opts?.height === 1) {
      excludedKeys.add(key)
      excluded += 1
      return
    }
    if (opts?.decorative) {
      let path = low
      try {
        path = new URL(abs).pathname.toLowerCase()
      } catch {
        /* keep full URL */
      }
      const decorativeToken = /(logo|sprite|spacer|placeholder|loading|tracker|pixel|favicon)/.test(path) || /(^|[-_./])(icon|blank|transparent|avatar)([-_.]|$)/.test(path)
      if (decorativeToken || low.includes('apple-touch-icon')) {
        excludedKeys.add(key)
        excluded += 1
        return
      }
    }
    n += 1
    const alt = (opts?.alt ?? '').trim()
    const title = alt && alt.toLowerCase() !== 'untitled' && alt.toLowerCase() !== 'unknown' ? alt.slice(0, 120) : safeBaseName(pageTitle, n)
    seen.set(key, { url: abs, title, format: guessExt(abs), width: opts?.width, height: opts?.height })
  }

  // <img ...> attributes
  const imgRe = /<img\b[^>]*>/gi
  let tag: RegExpExecArray | null
  while ((tag = imgRe.exec(html)) !== null) {
    const t = tag[0]
    const width = numOrUndef(attr(t, 'width'))
    const height = numOrUndef(attr(t, 'height'))
    const alt = attr(t, 'alt')
    push(attr(t, 'src'), { alt, width, height, decorative: true })
    push(attr(t, 'data-src'), { alt, width, height, decorative: true })
    push(attr(t, 'data-original'), { alt, width, height, decorative: true })
    push(attr(t, 'data-lazy-src'), { alt, width, height, decorative: true })
    push(attr(t, 'data-full'), { alt, width, height, decorative: true })
    const srcset = attr(t, 'srcset') ?? attr(t, 'data-srcset')
    if (srcset) push(largestFromSrcset(srcset), { alt, width, height, decorative: true })
  }

  // Open Graph / Twitter / image_src link
  const metaRe = /<meta\b[^>]*>/gi
  while ((tag = metaRe.exec(html)) !== null) {
    const t = tag[0]
    const prop = (attr(t, 'property') ?? attr(t, 'name') ?? '').toLowerCase()
    if (['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(prop)) {
      push(attr(t, 'content'))
    }
  }
  const linkRe = /<link\b[^>]*rel=["']image_src["'][^>]*>/gi
  while ((tag = linkRe.exec(html)) !== null) push(attr(tag[0], 'href'))

  // JSON-LD
  const ldRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]{0,200000}?)<\/script>/gi
  let ld: RegExpExecArray | null
  while ((ld = ldRe.exec(html)) !== null) {
    const body = ld[1]
    const imgField = /"image"\s*:\s*(\[[^\]]{0,5000}\]|"[^"]{1,2000}")/gi
    let f: RegExpExecArray | null
    while ((f = imgField.exec(body)) !== null) {
      const val = f[1]
      if (val.startsWith('"')) {
        const u = val.slice(1, -1)
        if (/^https?:\/\//i.test(u)) push(u)
      } else {
        const urls = val.match(/https?:\/\/[^"\s,\\]+/gi) ?? []
        for (const u of urls) push(u)
      }
    }
  }

  // Embedded absolute image URLs in page text
  const htmlNoSrcset = html.replace(/\s(?:data-)?srcset\s*=\s*"[^"]*"|\s(?:data-)?srcset\s*=\s*'[^']*'/gi, ' ')
  const embedded = htmlNoSrcset.match(/https?:\/\/[^\s"'<>\\]{1,2000}?\.(?:jpg|jpeg|png|webp|gif|bmp|svg|avif)(?:[?#][^\s"'<>\\]{0,500})?/gi) ?? []
  for (const u of embedded.slice(0, 2000)) push(u.replace(/[.,;:'")\]]+$/, ''), { decorative: true })

  return { images: [...seen.values()], excluded }
}

// ---------------------------------------------------------------------------
// Web / image-search page extraction (extends the unified image pipeline).
//
//   URL -> lightweight classifier -> direct image | image-search | web page
//   Web page -> safe HTML fetch -> static markup parse -> image URL list
//   -> select -> per-image jobs through the EXISTING queue/download/history.
//
// Rules:
// - Plain HTTP(S) GET only, no cookies/auth, no JavaScript execution. Page
//   <script> text is only scanned statically for embedded image URLs.
// - Public content only: login/captcha/consent/anti-bot pages produce a clear
//   error instead of any circumvention attempt.
// - HTML parsing is lightweight regex-based (no full DOM, no per-image
//   downloads during analysis).
// ---------------------------------------------------------------------------

export const SEARCH_PAGE_MESSAGE =
  'Image results could not be extracted from this page. Try opening a page containing the images or paste a direct image URL.'

const PAGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VIDAUD/1.0'

const FETCH_TIMEOUT_MS = 20000
const MAX_HTML_BYTES = 3 * 1024 * 1024

export type UrlKind = 'direct-image' | 'image-search' | 'other'

/** True for Google/Bing/Yahoo/DuckDuckGo/Yandex/Brave image-search result pages. */
export function isImageSearchUrl(rawUrl: string): boolean {
  let u: URL
  try {
    u = new URL(rawUrl.trim())
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.toLowerCase()
  const q = u.searchParams
  // Google Images: /search?tbm=isch, /searchbyimage, images.google.*
  if (host.startsWith('images.google.') || (host.includes('google.') && (path.startsWith('/searchbyimage') || (path.startsWith('/search') && q.get('tbm') === 'isch')))) return true
  // Bing Images
  if ((host === 'bing.com' || host.endsWith('.bing.com')) && path.startsWith('/images/search')) return true
  // Yahoo Images
  if (host === 'images.search.yahoo.com' || (host.endsWith('search.yahoo.com') && path.startsWith('/search') && (q.get('imgsz') !== null || (q.get('ei') !== null && path.includes('images'))))) return true
  // DuckDuckGo Images
  if ((host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) && (q.get('iax') === 'images' || q.get('ia') === 'images')) return true
  // Yandex Images
  if ((host === 'yandex.com' || host.endsWith('.yandex.com') || host === 'ya.ru') && path.startsWith('/images/search')) return true
  // Brave Images
  if (host === 'search.brave.com' && path.startsWith('/images')) return true
  // Ecosia Images
  if ((host === 'ecosia.org' || host.endsWith('.ecosia.org')) && path.startsWith('/images')) return true
  return false
}

/** Lightweight classifier: no network, URL shape only. */
export function classifyImageUrl(rawUrl: string): UrlKind {
  try {
    const u = new URL(rawUrl.trim())
    const ext = (u.pathname.split('/').pop()?.split('.').pop() ?? '').toLowerCase()
    if ((IMAGE_URL_EXTS as readonly string[]).includes(ext)) return 'direct-image'
  } catch {
    /* not a parseable URL -> 'other' */
  }
  if (isImageSearchUrl(rawUrl)) return 'image-search'
  return 'other'
}

interface FetchedPage {
  html: string
  finalUrl: string
  status: number
  contentType: string | null
}

/** Safe page fetch: bounded size + timeout, redirects followed, no credentials. */
function fetchPageHtml(rawUrl: string, signal?: AbortSignal): Promise<FetchedPage> {
  return new Promise((resolve, reject) => {
    let target = rawUrl.trim()
    let hops = 0
    const attempt = (): void => {
      if (signal?.aborted) {
        reject(new DownloadFailure('IMAGE_PAGE_CANCELLED', 'Image analysis cancelled.'))
        return
      }
      let u: URL
      try {
        u = new URL(target)
      } catch {
        reject(new DownloadFailure('IMAGE_PAGE_INVALID', 'The link is invalid or not supported.'))
        return
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        reject(new DownloadFailure('IMAGE_PAGE_INVALID', 'Only public http(s) pages can be analyzed for images.'))
        return
      }
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.get(
        u,
        { headers: { 'User-Agent': PAGE_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, timeout: FETCH_TIMEOUT_MS },
        (res) => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location && hops < 5) {
            res.resume()
            hops += 1
            try {
              target = new URL(res.headers.location, target).toString()
            } catch {
              reject(new DownloadFailure('IMAGE_PAGE_INVALID', 'The page redirect is invalid.'))
              return
            }
            attempt()
            return
          }
          if (status === 401) {
            res.resume()
            reject(new DownloadFailure('IMAGE_PAGE_BLOCKED', 'This page requires login. Only publicly accessible pages can be analyzed.', `HTTP Status: 401\nFinal URL: ${target.split('?')[0]}`))
            return
          }
          if (status === 403) {
            res.resume()
            reject(
              new DownloadFailure(
                'IMAGE_PAGE_BLOCKED',
                'Access to this page was refused (HTTP 403). It may require login or block automated access.',
                `HTTP Status: 403\nFinal URL: ${target.split('?')[0]}`
              )
            )
            return
          }
          if (status === 404) {
            res.resume()
            reject(new DownloadFailure('IMAGE_PAGE_HTTP', 'Page not found (HTTP 404).', `HTTP Status: 404\nFinal URL: ${target.split('?')[0]}`))
            return
          }
          if (status === 429) {
            res.resume()
            reject(
              new DownloadFailure(
                'IMAGE_PAGE_BLOCKED',
                'The website is rate-limiting requests (HTTP 429). Try again later or paste a direct image URL.',
                `HTTP Status: 429\nFinal URL: ${target.split('?')[0]}`
              )
            )
            return
          }
          if (status < 200 || status >= 300) {
            res.resume()
            reject(new DownloadFailure('IMAGE_PAGE_HTTP', `The page returned HTTP ${status}.`, `HTTP Status: ${status}\nFinal URL: ${target.split('?')[0]}`))
            return
          }
          const rawCt = Array.isArray(res.headers['content-type']) ? res.headers['content-type'][0] : res.headers['content-type']
          const ct = rawCt ? rawCt.split(';')[0].trim().toLowerCase() : null
          if (ct && !ct.includes('html') && !ct.includes('xhtml') && !ct.includes('text')) {
            res.resume()
            reject(
              new DownloadFailure(
                'IMAGE_PAGE_INVALID',
                ct.startsWith('image/') ? 'This link is a direct image. Analyzing it as a single image instead.' : `The link returned ${ct} instead of a web page.`,
                `HTTP Status: ${status}\nContent-Type: ${ct}`
              )
            )
            return
          }
          const chunks: Buffer[] = []
          let received = 0
          let truncated = false
          res.on('data', (d: Buffer) => {
            received += d.length
            if (received <= MAX_HTML_BYTES) chunks.push(d)
            else if (!truncated) {
              truncated = true
              try {
                res.destroy()
              } catch {
                /* ignore */
              }
            }
          })
          let settled = false
          const done = (): void => {
            if (settled) return
            settled = true
            const html = Buffer.concat(chunks).toString('utf8')
            logger.info(`[VIDAUD][WEBIMG] Fetched ${html.length} chars from ${target.split('?')[0]} (status=${status})`)
            resolve({ html, finalUrl: target, status, contentType: ct })
          }
          res.on('end', done)
          res.on('close', () => {
            if (chunks.length > 0) done()
          })
          res.on('error', (e: Error) => reject(new DownloadFailure('IMAGE_PAGE_HTTP', `Could not read the page: ${e.message}`)))
        }
      )
      req.on('error', (e: Error) => reject(new DownloadFailure('IMAGE_PAGE_HTTP', `Could not fetch the page: ${e.message}`)))
      req.on('timeout', () => req.destroy(new Error('Page request timed out. The server may be slow or unreachable.')))
    }
    attempt()
  })
}

/** Block markers that indicate login/captcha/consent/anti-bot pages. */
function detectPageBlock(html: string): string | null {
  const head = html.slice(0, 200000).toLowerCase()
  if (head.includes('cf-challenge') || head.includes('challenge-platform') || head.includes('cf_clearance')) return 'bot protection challenge'
  if (head.includes('recaptcha') && head.includes('unusual traffic')) return 'CAPTCHA / unusual-traffic check'
  if (head.includes('our systems have detected unusual traffic')) return 'unusual-traffic check'
  if (head.includes('consent.google.com') || (head.includes('consent') && head.includes('before you continue'))) return 'consent page'
  if (head.includes('sign in to continue') && head.includes('password')) return 'login page'
  return null
}

function pageTitle(html: string, fallbackUrl: string): string {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)
  const raw = m?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
  if (raw && raw.toLowerCase() !== 'untitled' && raw.toLowerCase() !== 'unknown') return raw
  try {
    return new URL(fallbackUrl).hostname.replace(/^www\./, '')
  } catch {
    return 'Web page'
  }
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*'([^']*)'|${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag)
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? null)?.trim() || null
}

function numOrUndef(v: string | null): number | undefined {
  if (!v) return undefined
  const n = Number(/(\d+)/.exec(v)?.[1])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function largestFromSrcset(srcset: string): string | null {
  // "url1 300w, url2 1200w" -> last URL (largest). "url 2x" handled the same way.
  const parts = srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : null
}

function guessExt(url: string): string | null {
  try {
    const base = new URL(url).pathname.split('/').pop() ?? ''
    const m = /\.([a-z0-9]{2,5})$/i.exec(base)
    if (!m) return null
    const e = m[1].toLowerCase()
    return (IMAGE_URL_EXTS as readonly string[]).includes(e) ? (e === 'jpeg' ? 'jpg' : e === 'tif' ? 'tiff' : e) : null
  } catch {
    return null
  }
}

export interface ExtractedImage {
  url: string
  title: string
  format: string | null
  width?: number
  height?: number
  /** For image-search results: thumbnail URL for display (may differ from download URL) */
  thumbnail?: string
  /** For image-search results: the original/high-res image URL */
  originalUrl?: string
  /** For image-search results: the source page URL where the image was found */
  sourcePageUrl?: string
  /** For image-search results: the source website domain */
  source?: string
  /** For image-search results: true when original image is accessible, false when only thumbnail available */
  originalAvailable?: boolean
}

function canonicalKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    // Trailing-slash and host-case noise must not create duplicates.
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`
  } catch {
    return url.split('#')[0]
  }
}

function safeBaseName(page: string, n: number): string {
  const cleaned = page.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 60) || 'Web image'
  return `${cleaned}-${String(n).padStart(2, '0')}`
}

/**
 * Static markup scan (no JS execution): img src and data attributes, srcset,
 * Open Graph, Twitter cards, link rel=image_src, JSON-LD image fields, plus
 * embedded absolute image URLs in page text (covers JS-rendered payloads).
 */
export function extractImageUrls(html: string, baseUrl: string, page: string): { images: ExtractedImage[]; excluded: number } {
  const seen = new Map<string, ExtractedImage>()
  // Keys the markup pass deliberately excluded (tracking pixels, favicons).
  // The page-text scan below must never resurrect them.
  const excludedKeys = new Set<string>()
  let excluded = 0
  let n = 0

  const push = (raw: string | null | undefined, opts?: { alt?: string | null; width?: number; height?: number; decorative?: boolean }): void => {
    if (!raw) return
    const src = raw.trim()
    if (!src || src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('javascript:') || src.startsWith('about:')) return
    let abs: string
    try {
      abs = new URL(src, baseUrl).toString()
    } catch {
      return
    }
    if (!abs.startsWith('http://') && !abs.startsWith('https://')) return
    const key = canonicalKey(abs)
    if (seen.has(key) || excludedKeys.has(key)) return
    // Obvious non-content assets are excluded from the start.
    const low = abs.toLowerCase()
    if (low.endsWith('.ico') || low.includes('/favicon') || low.includes('apple-touch-icon')) {
      excludedKeys.add(key)
      excluded += 1
      return
    }
    if (opts?.width === 1 && opts?.height === 1) {
      excludedKeys.add(key)
      excluded += 1 // 1x1 tracking pixel
      return
    }
    // <img> markup and free-text scans also drop clearly decorative assets
    // (header logos, sprites, spacers, placeholders, ...). Metadata images
    // (og:image / twitter:image / image_src) are treated as content and never
    // filtered by this heuristic — they represent the page's main image.
    if (opts?.decorative) {
      let path = low
      try {
        path = new URL(abs).pathname.toLowerCase()
      } catch {
        /* keep full URL */
      }
      const decorativeToken = /(logo|sprite|spacer|placeholder|loading|tracker|pixel|favicon)/.test(path) || /(^|[-_./])(icon|blank|transparent|avatar)([-_.]|$)/.test(path)
      if (decorativeToken || low.includes('apple-touch-icon')) {
        excludedKeys.add(key)
        excluded += 1 // decorative / UI asset
        return
      }
    }
    n += 1
    const alt = (opts?.alt ?? '').trim()
    const title = alt && alt.toLowerCase() !== 'untitled' && alt.toLowerCase() !== 'unknown' ? alt.slice(0, 120) : safeBaseName(page, n)
    seen.set(key, { url: abs, title, format: guessExt(abs), width: opts?.width, height: opts?.height })
  }

  // <img ...> attributes (spec: src, data-src, data-original, data-lazy-src, srcset).
  const imgRe = /<img\b[^>]*>/gi
  let tag: RegExpExecArray | null
  while ((tag = imgRe.exec(html)) !== null) {
    const t = tag[0]
    const width = numOrUndef(attr(t, 'width'))
    const height = numOrUndef(attr(t, 'height'))
    const alt = attr(t, 'alt')
    push(attr(t, 'src'), { alt, width, height, decorative: true })
    push(attr(t, 'data-src'), { alt, width, height, decorative: true })
    push(attr(t, 'data-original'), { alt, width, height, decorative: true })
    push(attr(t, 'data-lazy-src'), { alt, width, height, decorative: true })
    push(attr(t, 'data-full'), { alt, width, height, decorative: true })
    const srcset = attr(t, 'srcset') ?? attr(t, 'data-srcset')
    if (srcset) push(largestFromSrcset(srcset), { alt, width, height, decorative: true })
  }

  // Open Graph / Twitter / image_src link.
  const metaRe = /<meta\b[^>]*>/gi
  while ((tag = metaRe.exec(html)) !== null) {
    const t = tag[0]
    const prop = (attr(t, 'property') ?? attr(t, 'name') ?? '').toLowerCase()
    if (['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(prop)) {
      push(attr(t, 'content'))
    }
  }
  const linkRe = /<link\b[^>]*rel=["']image_src["'][^>]*>/gi
  while ((tag = linkRe.exec(html)) !== null) push(attr(tag[0], 'href'))

  // Structured metadata: JSON-LD "image" fields.
  const ldRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]{0,200000}?)<\/script>/gi
  let ld: RegExpExecArray | null
  while ((ld = ldRe.exec(html)) !== null) {
    const body = ld[1]
    const imgField = /"image"\s*:\s*(\[[^\]]{0,5000}\]|"[^"]{1,2000}")/gi
    let f: RegExpExecArray | null
    while ((f = imgField.exec(body)) !== null) {
      const val = f[1]
      if (val.startsWith('"')) {
        const u = val.slice(1, -1)
        if (/^https?:\/\//i.test(u)) push(u)
      } else {
        const urls = val.match(/https?:\/\/[^"\s,\\]+/gi) ?? []
        for (const u of urls) push(u)
      }
    }
  }

  // Embedded absolute image URLs anywhere in the page text (search-result
  // payloads). Static text scan only — no script execution. srcset attribute
  // values are stripped first so size variants never surface as extra results
  // (the markup pass already kept the largest variant).
  const htmlNoSrcset = html.replace(/\s(?:data-)?srcset\s*=\s*"[^"]*"|\s(?:data-)?srcset\s*=\s*'[^']*'/gi, ' ')
  const embedded = htmlNoSrcset.match(/https?:\/\/[^\s"'<>\\]{1,2000}?\.(?:jpg|jpeg|png|webp|gif|bmp|svg|avif)(?:[?#][^\s"'<>\\]{0,500})?/gi) ?? []
  for (const u of embedded.slice(0, 2000)) push(u.replace(/[.,;:'")\]]+$/, ''), { decorative: true })

  return { images: [...seen.values()], excluded }
}

export interface WebImageAnalyzeResult {
  pageTitle: string
  finalUrl: string
  kind: 'web' | 'search'
  images: ExtractedImage[]
  excluded: number
}

async function analyzePageInternal(rawUrl: string, originalUrl: string, kind: 'web' | 'search', signal?: AbortSignal): Promise<WebImageAnalyzeResult> {
  const page = await fetchPageHtml(rawUrl, signal)
  const title = pageTitle(page.html, page.finalUrl)

  let images: ExtractedImage[]
  let excluded: number

  if (kind === 'search' && isGoogleImagesUrl(originalUrl)) {
    // Use specialized Google Images extraction that parses embedded JSON data
    const googleResults = decodeGoogleImagesData(page.html)
    logger.info(`[VIDAUD][WEBIMG] Google Images extraction found ${googleResults.length} results from embedded data`)

    // Convert Google results to ExtractedImage format
    images = googleResults.map((r, i) => {
      const img: GoogleExtractedImage = {
        url: r.original,
        title: r.title || `Google Image ${i + 1}`,
        format: guessExt(r.original) || guessExt(r.thumbnail),
        width: r.width || undefined,
        height: r.height || undefined,
        thumbnail: r.thumbnail,
        originalUrl: r.original,
        sourcePageUrl: r.sourcePage,
        source: r.sourcePage ? new URL(r.sourcePage).hostname.replace(/^www\./, '') : undefined,
        originalAvailable: r.original !== r.thumbnail
      }
      return img
    })

    // If Google extraction yielded no results, fall back to markup extraction
    if (images.length === 0) {
      const fallback = extractImageUrls(page.html, page.finalUrl, title)
      images = fallback.images
      excluded = fallback.excluded
      logger.info(`[VIDAUD][WEBIMG] Google Images: fell back to markup extraction -> ${images.length} images`)
    } else {
      excluded = 0
    }
  } else {
    // Normal web page or other search engines: use markup extraction
    const result = extractImageUrls(page.html, page.finalUrl, title)
    images = result.images
    excluded = result.excluded
  }

  logger.info(`[VIDAUD][WEBIMG] ${kind} page "${title}" -> ${images.length} images (${excluded} junk excluded)`)

  if (images.length === 0) {
    const block = detectPageBlock(page.html)
    const originalUrl = page.finalUrl // The URL we started with (after redirects)
    // Also check the original input URL for Google detection since final URL may have changed
    const isGoogleImages = kind === 'search' && isGoogleImagesUrl(rawUrl)
    if (kind === 'search') {
      let detail: string
      if (isGoogleImages) {
        detail = 'Google Images requires JavaScript to load results. Try enabling "Use Browser Session" in Settings to use your logged-in browser cookies, or paste a direct image URL instead.'
      } else if (block) {
        detail = `The page appears to show a ${block} instead of public results.`
      } else {
        detail = 'The page is likely rendered dynamically (JavaScript) or protected, so no public image URLs could be read.'
      }
      throw new DownloadFailure(
        'IMAGE_SEARCH_EMPTY',
        `${SEARCH_PAGE_MESSAGE} (${detail})`,
        `Final URL: ${page.finalUrl.split('?')[0]}\nHTTP Status: ${page.status}\nImages found: 0`
      )
    }
    const detail = block
      ? `The page appears to show a ${block} instead of public content.`
      : 'No downloadable image references were found in the page markup.'
    throw new DownloadFailure(
      'HTML_PAGE_NO_IMAGE',
      'This link opens a web page. No directly downloadable image was found.',
      `Final URL: ${page.finalUrl.split('?')[0]}\nHTTP Status: ${page.status}\nPage title: ${title}\n${detail}`
    )
  }
  return { pageTitle: title, finalUrl: page.finalUrl, kind, images, excluded }
}

// Check if the URL is a Google Images page (for specialized extraction)
function isGoogleImagesUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    return host.startsWith('images.google.') || (host.includes('google.') && u.pathname.startsWith('/search') && u.searchParams.get('tbm') === 'isch')
  } catch {
    return false
  }
}

/** Normal web/gallery page analysis. Throws DownloadFailure with a clear message. */
export function analyzeWebPageImages(rawUrl: string, signal?: AbortSignal): Promise<WebImageAnalyzeResult> {
  return analyzePageInternal(rawUrl, rawUrl, 'web', signal)
}

/** Image-search result page analysis. Uses the search-specific guidance message. */
export function analyzeImageSearchPage(rawUrl: string, signal?: AbortSignal): Promise<WebImageAnalyzeResult> {
  return analyzePageInternal(rawUrl, rawUrl, 'search', signal)
}

/** Stable per-image id for gallery entries (dedupe key across re-analyze). */
export function imageEntryId(imageUrl: string): string {
  return createHash('sha1').update(canonicalKey(imageUrl)).digest('hex').slice(0, 16)
}
