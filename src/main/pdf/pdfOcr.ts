import { app } from 'electron'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join, normalize, resolve } from 'node:path'
import { logger } from '../utils/logger'

/**
 * Scanned-page OCR powered by tesseract.js (pure WASM, runs in a worker
 * thread). Fully offline: the traineddata files ship inside `resources/ocr`
 * (packaged: `<resources>/ocr`) and the tesseract.js packages are unpacked
 * next to the asar so the worker thread can load the real files.
 *
 * Every failure here is non-fatal: the PDF converter degrades gracefully
 * when OCR is unavailable.
 */

export interface OcrStatus {
  available: boolean
  languages: string[]
}

const TRAINED_LANGS = ['eng', 'ara', 'fra']

interface OcrPaths {
  available: boolean
  reason?: string
  dataDir?: string | null
  workerPath?: string | null
  langs: string[]
}

interface OcrWord {
  text: string
  confidence: number
  bbox: { x: number; y: number; w: number; h: number }
}

export interface OcrPageResult {
  text: string
  words: OcrWord[]
  confidence: number
  language: string
  status: string
}

let paths: OcrPaths | null = null
let workerPromise: Promise<unknown> | null = null

let httpServer: Server | null = null
let httpServerReady: Promise<string> | null = null

/**
 * tesseract.js classifies Electron as env `electron`, which makes its worker
 * treat `langPath` as a URL and fetch it (node-fetch cannot read local paths).
 * Serve the traineddata directory over loopback HTTP so the worker can always
 * fetch offline regardless of dev/packaged layout.
 */
function startFileServer(dataDir: string): Promise<string> {
  if (httpServerReady) return httpServerReady

  httpServerReady = new Promise((resolveReady, rejectReady) => {
    const root = resolve(dataDir)
    const server = createServer((req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405).end()
          return
        }
        const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
        const filePath = resolve(normalize(join(root, urlPath)))
        if (!filePath.startsWith(root)) {
          res.writeHead(403).end()
          return
        }
        const size = statSync(filePath).size
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
          'Cache-Control': 'no-store'
        })
        if (req.method === 'GET') {
          createReadStream(filePath).pipe(res)
        } else {
          res.end()
        }
      } catch {
        res.writeHead(404).end()
      }
    })
    server.on('error', (err) => rejectReady(err))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        rejectReady(new Error('OCR file server did not get a port'))
        return
      }
      httpServer = server
      logger.info(`[VIDAUD][PDF] OCR file server listening on 127.0.0.1:${address.port}`)
      resolveReady(`http://127.0.0.1:${address.port}`)
    })
  })

  return httpServerReady
}

/** Stop the OCR file server and allow a fresh worker to be created (app quit). */
export function disposeOcr(): void {
  if (httpServer) {
    try {
      httpServer.close()
    } catch {
      /* ignore */
    }
    httpServer = null
  }
  httpServerReady = null
  workerPromise = null
}

function findFirst(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

function resolvePaths(): OcrPaths {
  if (paths) return paths

  const dataDir = findFirst([
    join(process.resourcesPath, 'ocr'),
    join(app.getAppPath(), 'resources', 'ocr')
  ])

  const workerPath = findFirst([
    join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
    join(app.getAppPath(), 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
    join(process.resourcesPath, 'app.asar', 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js')
  ])

  const langs: string[] = []
  if (dataDir) {
    for (const lang of TRAINED_LANGS) {
      if (existsSync(join(dataDir, `${lang}.traineddata`))) langs.push(lang)
    }
  }

  let resolved: OcrPaths
  if (!workerPath) {
    resolved = { available: false, reason: 'ocr-unavailable', langs: [] }
  } else if (!dataDir || langs.length === 0) {
    resolved = {
      available: true,
      reason: 'no-tessdata',
      dataDir,
      workerPath,
      langs
    }
  } else {
    resolved = { available: true, dataDir, workerPath, langs }
  }

  paths = resolved
  return resolved
}

export function getOcrStatus(): OcrStatus {
  const p = resolvePaths()
  return { available: p.available && p.langs.length > 0, languages: p.langs ?? [] }
}

function loadTesseract(): unknown {
  // tesseract.js is a CJS runtime dependency (externalized in the build). It is
  // loaded lazily so an install hiccup never blocks the PDF viewer.
  return require('tesseract.js')
}

function defaultLanguage(langs: string[]): string {
  const preferred = ['ara', 'eng', 'fra']
  const chosen = preferred.filter((lang) => langs.includes(lang))
  if (chosen.length > 1) return chosen.join('+')
  return chosen[0] ?? langs[0]
}

/** Run OCR on a rasterized page buffer and return recognized text + per-word boxes. */
export async function recognizePage(
  imageBuffer: Buffer,
  options?: {
    lang?: string
    onProgress?: (status: string, progress: number) => void
  }
): Promise<OcrPageResult> {
  const p = resolvePaths()
  if (!p.available) throw new Error('OCR engine is not available')
  if (p.langs.length === 0) throw new Error('OCR language data is not installed')

  const Tesseract = loadTesseract() as {
    recognize: (
      image: Buffer | Uint8Array | string,
      lang: string,
      opts?: Record<string, unknown>
    ) => Promise<{ data: { text?: string; confidence?: number; words?: Array<{ text: string; confidence: number; bbox: { x: number; y: number; w: number; h: number } }> } }>
  }

  const lang = options?.lang ?? defaultLanguage(p.langs)
  const dataDir = p.dataDir ? await startFileServer(p.dataDir) : undefined

  const result = await Promise.race([
    Tesseract.recognize(imageBuffer, lang, {
      langPath: dataDir,
      logger: (message: Record<string, unknown>) => {
        const nextStatus = typeof message?.status === 'string' ? message.status : 'Recognizing text...'
        const progress = typeof message?.progress === 'number' ? message.progress : 0
        options?.onProgress?.(nextStatus, progress)
      }
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('OCR timed out')), 180_000)
    )
  ])

  const words = Array.isArray(result?.data?.words)
    ? result.data.words
        .filter((word) => typeof word?.text === 'string' && word.text.trim().length > 0)
        .map((word) => ({
          text: String(word.text).trim(),
          confidence: Number(word.confidence ?? 0),
          bbox: {
            x: Number(word.bbox?.x ?? 0),
            y: Number(word.bbox?.y ?? 0),
            w: Number(word.bbox?.w ?? 0),
            h: Number(word.bbox?.h ?? 0)
          }
        }))
    : []

  const text = String(result?.data?.text ?? '').trim()
  return {
    text,
    words,
    confidence: Number(result?.data?.confidence ?? (words.length > 0 ? words.reduce((sum, item) => sum + item.confidence, 0) / words.length : 0)),
    language: lang,
    status: text ? 'OCR completed' : 'OCR failed'
  }
}
