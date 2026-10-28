import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { logger } from '../utils/logger'

export interface HttpResponseInfo {
  ok: boolean
  /** Final HTTP status code after following redirects. */
  status: number
  statusText: string
  /** Final response Content-Type (may be null when absent). */
  contentType: string | null
  /** Final response Content-Length (may be null when absent/chunked). */
  contentLength: number | null
  /** Number of redirects followed. */
  redirects: number
  /** Final URL after all redirects (sanitized for storage). */
  finalUrl: string
  /** First bytes of the body (up to 1024) for magic-byte sniffing. */
  bodyStart: Buffer
  error?: string
}

const INVALID_MEDIA_TYPES = ['text/html', 'application/json', 'text/plain', 'application/xml', 'text/xml']

/**
 * Sanitizes a URL for logging: keeps scheme + host + pathname, strips the
 * query string (signed YouTube URLs embed tokens/expires there) and any
 * embedded credentials. Never log the full stream URL.
 */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const user = u.username ? u.username : ''
    const host = user ? `${user}@${u.host}` : u.host
    return `${u.protocol}//${host}${u.pathname}`
  } catch {
    // Fall back to stripping everything after the first '?'.
    return raw.split('?')[0] ?? raw
  }
}

function normalizeContentType(raw: string | undefined): string | null {
  if (!raw) return null
  const idx = raw.indexOf(';')
  return (idx >= 0 ? raw.slice(0, idx) : raw).trim().toLowerCase()
}

function isInvalidMediaType(ct: string | null): boolean {
  if (!ct) return false
  if (INVALID_MEDIA_TYPES.some((t) => ct.includes(t))) return true
  return ct.split('/')[0] === 'text'
}

/** True when the Content-Type indicates a non-media payload (HTML/JSON/text). */
export function isNonMediaContentType(ct: string | null): boolean {
  return isInvalidMediaType(ct)
}

const PEEK_BYTES = 1024

interface PeekState {
  status: number
  statusText: string
  contentType: string | null
  contentLength: number | null
  redirects: number
  finalUrl: string
  received: number
  chunks: Buffer[]
}

/**
 * Verifies that a resolved media URL really returns media bytes before VIDAUD
 * commits to downloading it. Uses a Range GET (only the first KB is fetched,
 * the socket is destroyed immediately after) so it does not waste bandwidth.
 *
 * Follows redirects manually and reports the redirect chain, final status,
 * final Content-Type, Content-Length and the first bytes for signature
 * sniffing. A response that is actually HTML/JSON/text is rejected with
 * `ok:false` — such a payload must never be saved as an audio file.
 */
export function verifyMediaUrl(url: string, timeoutMs = 20_000): Promise<HttpResponseInfo> {
  const state: PeekState = {
    status: 0,
    statusText: '',
    contentType: null,
    contentLength: null,
    redirects: 0,
    finalUrl: '',
    received: 0,
    chunks: []
  }

  return new Promise((resolve) => {
    const done = (res: Partial<HttpResponseInfo>): void => {
      resolve({
        ok: false,
        status: state.status,
        statusText: state.statusText,
        contentType: state.contentType,
        contentLength: state.contentLength,
        redirects: state.redirects,
        finalUrl: state.finalUrl || sanitizeUrl(url),
        bodyStart: Buffer.concat(state.chunks),
        ...res
      })
    }

    const fetch = (target: string): void => {
      let u: URL
      try {
        u = new URL(target)
      } catch (e) {
        done({ error: `Invalid stream URL: ${e instanceof Error ? e.message : String(e)}` })
        return
      }
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.get(
        u,
        {
          headers: {
            Range: `bytes=0-${PEEK_BYTES - 1}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VIDAUD/1.0'
          },
          timeout: timeoutMs
        },
        (res) => {
          const status = res.statusCode ?? 0
          state.status = status
          state.statusText = res.statusMessage ?? ''
          state.contentType = normalizeContentType(res.headers['content-type'] as string | undefined)
          const len = res.headers['content-length']
          state.contentLength = len ? Number(len) : null
          state.finalUrl = sanitizeUrl(res.headers.location ?? target)

          const isRedirect = status >= 300 && status < 400 && !!res.headers.location
          if (isRedirect && state.redirects < 6) {
            state.redirects += 1
            logger.info(`[VIDAUD][AUDIO] Redirect ${state.redirects}: ${status} -> ${sanitizeUrl(res.headers.location!)}`)
            res.resume()
            fetch(new URL(res.headers.location!, u).toString())
            return
          }
          if (isRedirect) {
            res.resume()
            done({ error: 'Too many redirects while resolving the stream URL.' })
            return
          }

          const finish = (): void => {
            req.destroy()
            if (!state.status || state.status < 200 || state.status >= 300) {
              logger.info(`[VIDAUD][AUDIO] HTTP status: ${state.status} ${state.statusText}`)
              done({ error: `Stream URL returned HTTP ${state.status}${state.statusText ? ' ' + state.statusText : ''}. The stream URL may be expired.` })
              return
            }
            const ct = state.contentType
            logger.info(`[VIDAUD][AUDIO] HTTP status: ${state.status}`)
            logger.info(`[VIDAUD][AUDIO] Content-Type: ${ct ?? 'unknown'}`)
            if (state.contentLength !== null) logger.info(`[VIDAUD][AUDIO] Content-Length: ${state.contentLength} bytes`)
            logger.info(`[VIDAUD][AUDIO] Final URL: ${sanitizeUrl(state.finalUrl || url)}`)
            if (isInvalidMediaType(ct)) {
              logger.info(`[VIDAUD][AUDIO] Invalid content type: ${ct}`)
              logger.error('[VIDAUD][AUDIO] Invalid media response: the source returned a non-media page (HTML/JSON/text) instead of an audio stream.')
              done({
                ok: false,
                error: `The source returned a non-media response (${ct ?? 'unknown'}); expected an audio stream.`
              })
              return
            }
            resolve({
              ok: true,
              status: state.status,
              statusText: state.statusText,
              contentType: ct,
              contentLength: state.contentLength,
              redirects: state.redirects,
              finalUrl: state.finalUrl || sanitizeUrl(url),
              bodyStart: Buffer.concat(state.chunks)
            })
          }

          res.on('data', (d: Buffer) => {
            if (state.received >= PEEK_BYTES) {
              res.destroy()
              return
            }
            const want = Math.min(PEEK_BYTES - state.received, d.length)
            state.chunks.push(d.subarray(0, want))
            state.received += want
            if (state.received >= PEEK_BYTES) {
              res.destroy()
              finish()
            }
          })
          res.on('end', finish)
          res.on('error', finish)
        }
      )
      req.on('error', (e: Error) => {
        done({ error: `Stream URL request failed: ${e.message}` })
      })
      req.on('timeout', () => {
        req.destroy(new Error('Stream URL request timed out.'))
      })
    }

    fetch(url)
  })
}

/** Sniffs the leading bytes of a downloaded file for text/error payloads. */
export function sniffFileType(firstBytes: Buffer): 'html' | 'json' | 'text' | 'binary' {
  if (!firstBytes || firstBytes.length === 0) return 'binary'
  const sample = firstBytes.subarray(0, Math.min(firstBytes.length, 512))
  const head = sample.toString('utf8')
  const trimmed = head.replace(/^\uFEFF/, '').trimStart().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<?xml')) return 'html'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  let printable = 0
  for (const b of sample) {
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d) printable++
  }
  if (printable / sample.length > 0.9 && !head.includes('\x00')) return 'text'
  return 'binary'
}
