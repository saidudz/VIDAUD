import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, statSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { URL } from 'node:url'
import { sanitizeFilename } from '../utils/files'
import { logger } from '../utils/logger'
import { DownloadFailure } from './errors'

// ---------------------------------------------------------------------------
// Image URL download pipeline (unified with the video/audio queue architecture)
//   Image URL -> HTTP request -> validate response -> validate Content-Type
//   -> stream to disk -> detect format -> validate image -> save final file
// Streaming is used throughout; large images are never buffered in memory.
// ---------------------------------------------------------------------------

export const IMAGE_URL_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'svg']

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/x-tiff': 'tiff',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/heic-sequence': 'heic',
  'image/heif-sequence': 'heif',
  'image/svg+xml': 'svg'
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml'
}

export const ImageFailure = {
  IMAGE_DOWNLOAD_FAILED: 'IMAGE_DOWNLOAD_FAILED',
  IMAGE_FILE_EMPTY: 'IMAGE_FILE_EMPTY',
  IMAGE_DOWNLOAD_INVALID: 'IMAGE_DOWNLOAD_INVALID',
  IMAGE_FILE_INVALID: 'IMAGE_FILE_INVALID',
  IMAGE_HTTP_ERROR: 'IMAGE_HTTP_ERROR',
  /** URL classification: followed a redirect and the final page was searched, but no usable image was found. */
  HTML_PAGE_NO_IMAGE: 'HTML_PAGE_NO_IMAGE',
  /** URL classification: an assumed direct image did not turn out to be one (HTTP 4xx/5xx, dead link, ...). */
  DIRECT_IMAGE_NOT_FOUND: 'DIRECT_IMAGE_NOT_FOUND',
  /** URL classification: the redirect chain could not be resolved (broken or too many hops). */
  REDIRECT_FAILED: 'REDIRECT_FAILED',
  /** URL classification: the final response type is neither an image nor a public web page. */
  UNSUPPORTED_PAGE: 'UNSUPPORTED_PAGE'
} as const

export interface ImageProbe {
  ok: boolean
  contentType: string | null
  contentLength: number | null
  finalUrl: string
  serverFilename: string | null
  ext: string | null
  /** First bytes peeked during detection (for magic-byte sniffing, never a full download). */
  bodyStart: Buffer
  status: number
  error?: string
}

export interface ImageAnalyzeResult {
  type: 'image'
  title: string
  filename: string
  ext: string
  mimeType: string
  contentLength: number | null
  thumbnail: string
  webpageUrl: string
}

/** True when the URL path (ignoring query/fragment) ends with a known image extension. */
export function hasImageExtension(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim())
    const path = u.pathname.toLowerCase()
    return IMAGE_URL_EXTS.some((e) => path.endsWith(`.${e}`))
  } catch {
    const lower = rawUrl.trim().toLowerCase().split(/[?#]/)[0]
    return IMAGE_URL_EXTS.some((e) => lower.endsWith(`.${e}`))
  }
}

export function extFromPath(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim())
    const base = u.pathname.split('/').pop() ?? ''
    const m = /\.([a-z0-9]+)$/i.exec(base)
    if (!m) return null
    const ext = m[1].toLowerCase()
    return IMAGE_URL_EXTS.includes(ext) ? ext : null
  } catch {
    return null
  }
}

export function contentTypeToExt(ct: string | null): string | null {
  if (!ct) return null
  const base = ct.split(';')[0].trim().toLowerCase()
  return MIME_TO_EXT[base] ?? null
}

export function isImageContentType(ct: string | null): boolean {
  if (!ct) return false
  return ct.split(';')[0].trim().toLowerCase().startsWith('image/')
}

function isNonImageContentType(ct: string | null): boolean {
  if (!ct) return false
  const base = ct.split(';')[0].trim().toLowerCase()
  if (base.startsWith('image/')) return false
  return (
    base.startsWith('text/') ||
    base === 'text/html' ||
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'text/xml' ||
    base.includes('html') ||
    base.includes('json')
  )
}

/** Detects the image format from leading magic bytes. Returns ext or null. */
export function detectImageFormatFromBytes(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  // GIF: GIF87a / GIF89a
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('ascii')
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif'
  }
  // WEBP: RIFF....WEBP
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  // BMP: BM
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  // TIFF: II*\0 (49 49 2A 00) or MM\0* (4D 4D 00 2A)
  if (buf.length >= 4) {
    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return 'tiff'
  }
  // AVIF / HEIC / HEIF: ....ftypavif / ftypheic / ftypheif / ftypmif1 / ftypmsf1 / ftyphevc / ftyphevx
  if (buf.length >= 12) {
    const box = buf.subarray(4, 12).toString('ascii')
    if (box.startsWith('ftyp')) {
      const brand = buf.subarray(8, 12).toString('ascii')
      if (brand === 'avif') return 'avif'
      if (brand === 'heic') return 'heic'
      if (brand === 'heif' || brand === 'mif1' || brand === 'msf1' || brand === 'hevc' || brand === 'hevx') return 'heif'
      // Unknown ftyp brand inside an image probe — treat as heif-family only when
      // the Content-Type already said image/* (handled by caller fallback).
    }
  }
  // SVG: starts with <?xml or <svg (after optional whitespace/BOM)
  const textHead = buf.subarray(0, Math.min(buf.length, 512)).toString('utf8').replace(/^\uFEFF/, '').trimStart().slice(0, 256).toLowerCase()
  if (textHead.startsWith('<svg') || (textHead.startsWith('<?xml') && textHead.includes('<svg'))) return 'svg'
  return null
}

function filenameFromDisposition(header: string | undefined): string | null {
  if (!header) return null
  // RFC 5987 filename*=UTF-8''... takes precedence.
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      const decoded = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
      if (decoded) return decoded
    } catch {
      const raw = star[1].trim().replace(/^"|"$/g, '')
      if (raw) return raw
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(header)
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim().replace(/^"|"$/g, '')
  return name || null
}

function stableFallbackName(rawUrl: string, ext: string): string {
  try {
    const u = new URL(rawUrl.trim())
    const host = u.hostname.replace(/^www\./, '').split('.')[0] || 'image'
    const hash = createHash('sha1').update(rawUrl.trim()).digest('hex').slice(0, 8)
    return `${host}-image-${hash}.${ext}`
  } catch {
    const hash = createHash('sha1').update(rawUrl.trim()).digest('hex').slice(0, 8)
    return `image-${hash}.${ext}`
  }
}

/**
 * Derives a clean, never-"Untitled" filename for an image.
 * Priority: server Content-Disposition filename > URL basename > stable hash name.
 */
export function deriveImageFilename(rawUrl: string, opts: { contentDisposition?: string | null; contentType?: string | null; magicExt?: string | null }): { filename: string; ext: string } {
  const cdName = filenameFromDisposition(opts.contentDisposition ?? undefined)
  const ctExt = contentTypeToExt(opts.contentType ?? null)
  const magicExt = opts.magicExt ?? null
  const urlExt = extFromPath(rawUrl)

  // Extension priority: magic bytes > Content-Type > URL ext. Never trust ext alone.
  let ext = magicExt ?? ctExt ?? urlExt ?? 'jpg'
  ext = ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase()
  if (ext === 'tif') ext = 'tiff'

  let base: string | null = null
  if (cdName) {
    const clean = cdName.split(/[\\/]/).pop()?.trim() ?? ''
    if (clean) {
      const withoutExt = clean.replace(/\.[a-z0-9]+$/i, '')
      base = withoutExt || clean
    }
  }
  if (!base) {
    try {
      const u = new URL(rawUrl.trim())
      const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
      const decoded = decodeURIComponent(last).trim()
      if (decoded) {
        const withoutExt = decoded.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0600-\u06FF _\-.()[\]{}!&',+~]+/g, '').trim()
        if (withoutExt && withoutExt.toLowerCase() !== 'untitled' && withoutExt.toLowerCase() !== 'unknown' && !/^item\s*\d+$/i.test(withoutExt)) {
          base = withoutExt
        }
      }
    } catch {
      /* fall through to hash */
    }
  }
  if (!base) {
    return { filename: stableFallbackName(rawUrl, ext), ext }
  }
  const filename = sanitizeFilename(`${base}.${ext}`, stableFallbackName(rawUrl, ext))
  // sanitizeFilename falls back to 'download' on empty — replace that with a stable name.
  if (filename.toLowerCase().startsWith('download.')) {
    return { filename: stableFallbackName(rawUrl, ext), ext }
  }
  return { filename, ext }
}

interface RawHeaders {
  [k: string]: string | string[] | undefined
}

function getHeader(headers: RawHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()]
  if (Array.isArray(v)) return v[0]
  return v
}

const IMAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VIDAUD/1.0'

function doRequest(target: string, method: 'HEAD' | 'GET', headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; headers: RawHeaders; body: Buffer; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(target)
    } catch (e) {
      reject(new Error(`Invalid image URL: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      u,
      { method, headers: { 'User-Agent': IMAGE_UA, ...headers }, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        // For detection, only the first 64KB matter; destroy early.
        const wantDetectOnly = method === 'GET' && headers['Range'] !== undefined
        res.on('data', (d: Buffer) => {
          if (wantDetectOnly) {
            chunks.push(d)
            const total = chunks.reduce((a, c) => a + c.length, 0)
            if (total >= 65536) {
              res.destroy()
            }
          } else {
            chunks.push(d)
          }
        })
        res.on('end', () => {
          resolve({ status, headers: res.headers as RawHeaders, body: Buffer.concat(chunks), finalUrl: target })
        })
        res.on('error', (e) => reject(e))
      }
    )
    req.on('error', (e) => reject(e))
    req.on('timeout', () => {
      req.destroy(new Error('Image request timed out.'))
    })
    req.end()
  })
}

/**
 * Lightweight image probe: HEAD first (no body), falling back to a minimal
 * ranged GET (first bytes only) when HEAD is unsupported. Follows redirects.
 * Never downloads the full file.
 */
export async function probeImageUrl(rawUrl: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ImageProbe> {
  const timeoutMs = opts?.timeoutMs ?? 15000
  let target = rawUrl.trim()
  let redirects = 0
  const fail = (status: number, error: string, extra?: Partial<ImageProbe>): ImageProbe => ({
    ok: false,
    contentType: null,
    contentLength: null,
    finalUrl: target,
    serverFilename: null,
    ext: null,
    bodyStart: Buffer.alloc(0),
    status,
    error,
    ...extra
  })

  for (let hop = 0; hop < 7; hop++) {
    if (opts?.signal?.aborted) return fail(0, 'Image analysis cancelled.')
    let head: { status: number; headers: RawHeaders; body: Buffer; finalUrl: string } | null = null
    try {
      head = await doRequest(target, 'HEAD', {}, timeoutMs)
    } catch (e) {
      // HEAD network failure -> try ranged GET directly.
      head = null
      logger.debug(`[VIDAUD][IMAGE] HEAD failed for ${target.split('?')[0]}: ${e instanceof Error ? e.message : String(e)}; trying ranged GET`)
    }
    if (head) {
      const { status, headers } = head
      if (status >= 300 && status < 400 && getHeader(headers, 'location')) {
        redirects += 1
        target = new URL(getHeader(headers, 'location')!, target).toString()
        continue
      }
      if (status === 405 || status === 501 || status === 403 || status === 400) {
        // HEAD not allowed / rejected -> fall through to ranged GET on the same URL.
        break
      }
      if (status < 200 || status >= 300) {
        // Some servers deliberately answer odd statuses to HEAD while serving
        // the resource fine over GET (e.g. strict 400-on-HEAD CDNs). The
        // ranged GET below is authoritative: let it decide instead of failing
        // on a HEAD-only status.
        break
      }
      const ct = (getHeader(headers, 'content-type') ?? null) as string | null
      const normalized = ct ? ct.split(';')[0].trim().toLowerCase() : null
      const lenRaw = getHeader(headers, 'content-length')
      const len = lenRaw ? Number(Array.isArray(lenRaw) ? lenRaw[0] : lenRaw) : null
      const cd = getHeader(headers, 'content-disposition') ?? null
      const serverFilename = filenameFromDisposition(cd ?? undefined)
      if (normalized && isNonImageContentType(normalized)) {
        return fail(status, `The link returned ${normalized} instead of an image.`, { contentType: normalized, finalUrl: target, serverFilename })
      }
      if (normalized && isImageContentType(normalized)) {
        const ext = contentTypeToExt(normalized)
        return { ok: true, contentType: normalized, contentLength: Number.isFinite(len as number) ? (len as number) : null, finalUrl: target, serverFilename, ext, bodyStart: Buffer.alloc(0), status }
      }
      // No usable Content-Type from HEAD -> ranged GET for magic-byte sniffing.
      break
    } else {
      break
    }
    void redirects
  }

  // Minimal GET: first 64KB only (Range), enough for magic bytes + SVG sniffing.
  let getTarget = target
  for (let hop = 0; hop < 7; hop++) {
    if (opts?.signal?.aborted) return fail(0, 'Image analysis cancelled.')
    try {
      const res = await doRequest(getTarget, 'GET', { Range: 'bytes=0-65535' }, timeoutMs)
      const { status, headers, body } = res
      if ((status >= 300 && status < 400 && getHeader(headers, 'location')) || status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        const loc = getHeader(headers, 'location')
        if (loc) {
          getTarget = new URL(loc, getTarget).toString()
          target = getTarget
          continue
        }
      }
      if (status !== 200 && status !== 206) {
        return fail(status, `The link returned HTTP ${status}.`)
      }
      const ct = (getHeader(headers, 'content-type') ?? null) as string | null
      const normalized = ct ? ct.split(';')[0].trim().toLowerCase() : null
      const lenRaw = getHeader(headers, 'content-range') ?? getHeader(headers, 'content-length')
      let len: number | null = null
      if (lenRaw) {
        const m = /\/(\d+)\s*$/.exec(Array.isArray(lenRaw) ? lenRaw[0] : lenRaw)
        len = m ? Number(m[1]) : Number(Array.isArray(lenRaw) ? lenRaw[0] : lenRaw)
        if (!Number.isFinite(len)) len = null
      }
      const cd = getHeader(headers, 'content-disposition') ?? null
      const serverFilename = filenameFromDisposition(cd ?? undefined)
      if (normalized && isNonImageContentType(normalized)) {
        return fail(status, `The link returned ${normalized} instead of an image.`, { contentType: normalized, contentLength: len, finalUrl: getTarget, serverFilename, bodyStart: body.subarray(0, 1024) })
      }
      const magicExt = detectImageFormatFromBytes(body.subarray(0, Math.min(body.length, 65536)))
      if (magicExt) {
        const m = magicExt === 'tif' ? 'tiff' : magicExt
        return { ok: true, contentType: normalized, contentLength: len, finalUrl: getTarget, serverFilename, ext: m, bodyStart: body.subarray(0, 1024), status }
      }
      if (normalized && isImageContentType(normalized)) {
        const ext = contentTypeToExt(normalized)
        return { ok: true, contentType: normalized, contentLength: len, finalUrl: getTarget, serverFilename, ext, bodyStart: body.subarray(0, 1024), status }
      }
      // Last resort: URL extension, only when the payload is not HTML/JSON.
      const urlExt = extFromPath(getTarget) ?? extFromPath(rawUrl)
      if (urlExt && !isNonImageContentType(normalized)) {
        return { ok: true, contentType: normalized, contentLength: len, finalUrl: getTarget, serverFilename, ext: urlExt, bodyStart: body.subarray(0, 1024), status }
      }
      return fail(status, normalized ? `The link returned ${normalized} instead of a supported image.` : 'The link did not return a supported image.', {
        contentType: normalized,
        contentLength: len,
        finalUrl: getTarget,
        serverFilename,
        bodyStart: body.subarray(0, 1024)
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/timed out/i.test(msg)) return fail(0, 'Image request timed out. The server may be slow or unreachable.')
      if (/cancelled/i.test(msg)) return fail(0, 'Image analysis cancelled.')
      return fail(0, `Image request failed: ${msg}`)
    }
  }
  return fail(0, 'Too many redirects. The link could not be resolved.')
}

/**
 * Raised by `analyzeImageUrl` when the probe proves the URL is NOT a direct
 * image. Carries the full probe result (final URL after redirects, real
 * Content-Type, HTTP status) so the analyzer can classify the response
 * instead of showing the raw message: text/html means "web page — extract
 * images from it", an HTTP error means "dead/blocked link", anything else is
 * "unsupported".
 */
export class ImageProbeError extends DownloadFailure {
  probe: ImageProbe
  constructor(probe: ImageProbe) {
    super(
      ImageFailure.IMAGE_DOWNLOAD_INVALID,
      probe.error ?? 'The link did not return a supported image.',
      `HTTP Status: ${probe.status}\nContent-Type: ${probe.contentType ?? 'unknown'}\nFinal URL: ${probe.finalUrl.split('?')[0]}`
    )
    this.name = 'ImageProbeError'
    this.probe = probe
  }
}

/**
 * Builds the single-image MediaInfo result from a successful probe. Used both
 * by `analyzeImageUrl` (extension fast path) and directly by the URL
 * classifier so the traversal + probe happens exactly once per analyze.
 */
export function imageInfoFromProbe(probe: ImageProbe, rawUrl: string): ImageAnalyzeResult {
  const magicExt = probe.bodyStart.length > 0 ? detectImageFormatFromBytes(probe.bodyStart) : null
  const { filename, ext } = deriveImageFilename(probe.finalUrl, {
    contentDisposition: probe.serverFilename,
    contentType: probe.contentType,
    magicExt
  })
  const finalExt = probe.ext ?? ext
  const title = filename.replace(/\.[a-z0-9]+$/i, '')
  const mime = probe.contentType ?? EXT_TO_MIME[finalExt] ?? 'image/*'
  return {
    type: 'image',
    title,
    filename: filename.toLowerCase().endsWith(`.${finalExt}`) ? filename : `${title}.${finalExt}`,
    ext: finalExt,
    mimeType: mime,
    contentLength: probe.contentLength,
    thumbnail: probe.finalUrl,
    webpageUrl: rawUrl.trim()
  }
}

/**
 * Fast analyzer entry: probes a direct image URL and builds the MediaInfo-like
 * result. Never runs yt-dlp. When the URL is not a direct image it throws
 * `ImageProbeError` with the classification probe attached — callers decide
 * (web page / error / unsupported) instead of showing a raw HTTP message.
 */
export async function analyzeImageUrl(rawUrl: string, opts?: { signal?: AbortSignal }): Promise<ImageAnalyzeResult | null> {
  const probe = await probeImageUrl(rawUrl, { signal: opts?.signal })
  if (!probe.ok) throw new ImageProbeError(probe)
  return imageInfoFromProbe(probe, rawUrl)
}

export interface ImageDownloadEvents {
  onProgress?: (downloaded: number, total: number | null) => void
  isAborted?: () => { paused: boolean; cancelled: boolean }
}

/**
 * Streams an image URL to `destTmp` (a temp file, not the final path).
 * - Follows redirects, validates HTTP status + Content-Type before writing.
 * - Rejects HTML/JSON error pages (never saved as .jpg/.png).
 * - Supports Range resume when `destTmp.part` bytes already exist.
 * - Emits real byte progress; percent is derived only when total is known.
 */
export async function streamImageToDisk(imageUrl: string, destTmp: string, events?: ImageDownloadEvents, timeoutMs = 60000): Promise<{ contentType: string | null; contentLength: number | null; finalUrl: string; serverFilename: string | null; bytes: number }> {
  let target = imageUrl
  for (let hop = 0; hop < 7; hop++) {
    const abort = events?.isAborted?.()
    if (abort?.cancelled) throw new DownloadFailure(ImageFailure.IMAGE_DOWNLOAD_FAILED, 'Download cancelled.')
    if (abort?.paused) throw new DownloadFailure(ImageFailure.IMAGE_DOWNLOAD_FAILED, 'Download paused.')
    const result = await new Promise<{ status: number; headers: RawHeaders; stream: http.IncomingMessage }>((resolve, reject) => {
      let u: URL
      try {
        u = new URL(target)
      } catch (e) {
        reject(new Error(`Invalid image URL.`))
        return
      }
      // Resume: append to existing partial bytes when the server honors Range.
      let startByte = 0
      try {
        if (existsSync(destTmp) && statSync(destTmp).size > 0) startByte = statSync(destTmp).size
      } catch {
        startByte = 0
      }
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.get(
        u,
        {
          headers: {
            'User-Agent': IMAGE_UA,
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            ...(startByte > 0 ? { Range: `bytes=${startByte}-` } : {})
          },
          timeout: timeoutMs
        },
        (res) => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            target = new URL(res.headers.location, target).toString()
            resolve({ status, headers: res.headers as RawHeaders, stream: res })
            return
          }
          resolve({ status, headers: res.headers as RawHeaders, stream: res })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('Image download timed out.')))
    })

    const { status, headers, stream } = result
    if ((status >= 300 && status < 400) || (status as number) === 301) {
      stream.resume()
      continue
    }
    if (status === 404) {
      stream.resume()
      throw new DownloadFailure(ImageFailure.IMAGE_HTTP_ERROR, 'Image not found (HTTP 404). The file may have been removed.', `HTTP Status: 404\nFinal URL: ${target.split('?')[0]}`)
    }
    if (status === 403) {
      stream.resume()
      throw new DownloadFailure(ImageFailure.IMAGE_HTTP_ERROR, 'The image server refused the request (HTTP 403). Retrying...', `HTTP Status: 403\nFinal URL: ${target.split('?')[0]}`)
    }
    if (status >= 500) {
      stream.resume()
      throw new DownloadFailure(ImageFailure.IMAGE_HTTP_ERROR, `Image server error (HTTP ${status}). Retrying...`, `HTTP Status: ${status}\nFinal URL: ${target.split('?')[0]}`)
    }
    if (status !== 200 && status !== 206) {
      stream.resume()
      throw new DownloadFailure(ImageFailure.IMAGE_HTTP_ERROR, `Image download failed (HTTP ${status}).`, `HTTP Status: ${status}\nFinal URL: ${target.split('?')[0]}`)
    }
    const rawCt = getHeader(headers, 'content-type') ?? null
    const ct = rawCt ? String(rawCt).split(';')[0].trim().toLowerCase() : null
    if (ct && isNonImageContentType(ct)) {
      // Drain a small sample for diagnostics, then reject — never save HTML as image.
      await new Promise<void>((done) => {
        const chunks: Buffer[] = []
        let n = 0
        stream.on('data', (d: Buffer) => {
          if (n < 2048) {
            chunks.push(d)
            n += d.length
          }
        })
        stream.on('end', () => done())
        stream.on('error', () => done())
        setTimeout(() => {
          try {
            stream.destroy()
          } catch {
            /* ignore */
          }
          done()
        }, 3000)
      })
      throw new DownloadFailure(
        ImageFailure.IMAGE_DOWNLOAD_INVALID,
        `The link returned ${ct} instead of an image. An error page was not saved as an image.`,
        `HTTP Status: ${status}\nContent-Type: ${ct}\nFinal URL: ${target.split('?')[0]}`
      )
    }

    const lenRaw = getHeader(headers, 'content-length')
    const total = lenRaw ? Number(Array.isArray(lenRaw) ? lenRaw[0] : lenRaw) : null
    const cd = getHeader(headers, 'content-disposition') ?? null
    const serverFilename = filenameFromDisposition(cd ?? undefined)

    // Determine append vs truncate: 206 resumes, 200 restarts.
    const append = status === 206 && existsSync(destTmp)
    let downloaded = append ? statSync(destTmp).size : 0
    const startTotal = total !== null && Number.isFinite(total) ? (append ? downloaded + (total as number) : (total as number)) : null
    if (events?.onProgress) events.onProgress(downloaded, startTotal)

    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(destTmp, { flags: append ? 'a' : 'w' })
      let settled = false
      const fail = (e: Error): void => {
        if (settled) return
        settled = true
        try {
          out.destroy()
        } catch {
          /* ignore */
        }
        reject(e)
      }
      const poll = setInterval(() => {
        const a = events?.isAborted?.()
        if (a?.cancelled || a?.paused) {
          clearInterval(poll)
          try {
            stream.destroy(a.cancelled ? new Error('Download cancelled.') : new Error('Download paused.'))
          } catch {
            /* ignore */
          }
        }
      }, 200)
      stream.on('data', (d: Buffer) => {
        downloaded += d.length
        if (events?.onProgress) {
          try {
            events.onProgress(downloaded, startTotal)
          } catch {
            /* ignore */
          }
        }
      })
      stream.pipe(out)
      out.on('finish', () => {
        if (settled) return
        settled = true
        clearInterval(poll)
        resolve()
      })
      out.on('error', (e) => {
        clearInterval(poll)
        fail(e)
      })
      stream.on('error', (e: Error) => {
        clearInterval(poll)
        const msg = e.message || ''
        if (/cancelled/i.test(msg)) fail(new DownloadFailure(ImageFailure.IMAGE_DOWNLOAD_FAILED, 'Download cancelled.'))
        else if (/paused/i.test(msg)) fail(new DownloadFailure(ImageFailure.IMAGE_DOWNLOAD_FAILED, 'Download paused.'))
        else if (/timed out/i.test(msg)) fail(new DownloadFailure(ImageFailure.IMAGE_DOWNLOAD_FAILED, 'Image download timed out. Retrying...', `Final URL: ${target.split('?')[0]}`))
        else fail(new DownloadFailure(ImageFailure.IMAGE_DOWNLOAD_FAILED, `Image download interrupted: ${msg || 'connection reset'}`, `Final URL: ${target.split('?')[0]}`))
      })
    })

    return { contentType: ct, contentLength: startTotal, finalUrl: target, serverFilename, bytes: downloaded }
  }
  throw new DownloadFailure(ImageFailure.IMAGE_DOWNLOAD_FAILED, 'Too many redirects while downloading the image.')
}

/**
 * Validates a downloaded image file:
 * file exists, size > 0, valid image signature, correct media type,
 * parseable header. Returns ext + mime on success.
 */
export function validateImageFile(filePath: string, opts?: { expectedExt?: string | null; contentType?: string | null }): { ok: boolean; ext?: string; mime?: string; size?: number; error?: string; details?: string } {
  if (!existsSync(filePath)) return { ok: false, error: 'Downloaded image file is missing.', details: '[IMAGE_FILE_EMPTY] File does not exist after download.' }
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    return { ok: false, error: 'Downloaded image file is missing.', details: '[IMAGE_FILE_EMPTY] Cannot stat downloaded file.' }
  }
  if (size <= 0) return { ok: false, error: 'Downloaded image is empty (0 bytes).', details: '[IMAGE_FILE_EMPTY] File size is 0 bytes.' }
  if (size < 64) return { ok: false, error: 'Downloaded image is too small to be valid.', details: `[IMAGE_FILE_INVALID] File size is ${size} bytes.` }
  let head: Buffer
  try {
    const data = readFileSync(filePath)
    head = data.subarray(0, Math.min(data.length, 65536))
  } catch (e) {
    return { ok: false, error: 'Could not read the downloaded image.', details: `[IMAGE_FILE_INVALID] ${e instanceof Error ? e.message : String(e)}` }
  }
  // HTML/JSON error page saved as image? Reject with a clear technical error.
  const textHead = head.subarray(0, Math.min(head.length, 512)).toString('utf8').replace(/^\uFEFF/, '').trimStart().slice(0, 256).toLowerCase()
  if (textHead.startsWith('<!doctype') || textHead.startsWith('<html') || (textHead.startsWith('{') && !head.subarray(0, 4).equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))) {
    // Allow SVG (<svg / <?xml+svg) — everything else HTML/JSON is invalid.
    const isSvg = textHead.startsWith('<svg') || (textHead.startsWith('<?xml') && head.toString('utf8').toLowerCase().includes('<svg'))
    if (!isSvg) {
      return { ok: false, error: 'The server returned an error page instead of an image. The HTML page was not saved as an image.', details: `[IMAGE_DOWNLOAD_INVALID] Payload looks like ${textHead.startsWith('{') || textHead.startsWith('[') ? 'JSON' : 'HTML'}, not an image. Size: ${size} bytes.` }
    }
  }
  const magicExt = detectImageFormatFromBytes(head)
  if (!magicExt) {
    return { ok: false, error: 'Downloaded file is not a supported image.', details: `[IMAGE_FILE_INVALID] Magic-byte sniff found no known image signature. Size: ${size} bytes. Content-Type: ${opts?.contentType ?? 'unknown'}.` }
  }
  const ext = magicExt === 'tif' ? 'tiff' : magicExt
  const mime = EXT_TO_MIME[ext] ?? 'image/*'
  // SVG is preserved as-is (never rasterized); all raster formats pass with signature.
  logger.info(`[VIDAUD][IMAGE] Validated: ext=${ext}, mime=${mime}, size=${size} bytes`)
  return { ok: true, ext, mime, size }
}
