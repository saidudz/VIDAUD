// Downloads yt-dlp.exe and ffmpeg.exe into resources/bin/.
// These are the bundled runtime binaries for VIDAUD.
import { mkdirSync, writeFileSync, existsSync, statSync, createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import AdmZip from 'adm-zip'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const binDir = join(__dirname, '..', 'resources', 'bin')
const ocrDir = join(__dirname, '..', 'resources', 'ocr')
mkdirSync(binDir, { recursive: true })
mkdirSync(ocrDir, { recursive: true })

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

async function download(url, dest) {
  process.stdout.write(`  downloading ${url}\n`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  return existsSync(dest)
}

async function downloadWithRetry(url, dest, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      await download(url, dest)
      return
    } catch (e) {
      lastErr = e
      process.stdout.write(`    attempt ${i + 1} failed (${e.message}), retrying...\n`)
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  throw lastErr
}

async function ensureYtdlp() {
  const dest = join(binDir, 'yt-dlp.exe')
  if (existsSync(dest) && destSizeOk(dest)) {
    console.log('  yt-dlp.exe already present')
    return
  }
  // try the /latest/ redirect first, then a pinned version as fallback
  try {
    await downloadWithRetry(YTDLP_URL, dest)
  } catch (e) {
    process.stdout.write(`    latest download failed, trying pinned release...\n`)
    await downloadWithRetry('https://github.com/yt-dlp/yt-dlp/releases/download/2025.01.15/yt-dlp.exe', dest)
  }
  console.log('  yt-dlp.exe OK')
}

async function ensureFfmpeg() {
  const dest = join(binDir, 'ffmpeg.exe')
  if (existsSync(dest) && destSizeOk(dest)) {
    console.log('  ffmpeg.exe already present')
    return
  }
  const zipPath = join(binDir, '.ffmpeg.zip')
  await download(FFMPEG_URL, zipPath)
  process.stdout.write('  extracting ffmpeg.exe...\n')
  const zip = new AdmZip(zipPath)
  const entry = zip
    .getEntries()
    .find((e) => !e.isDirectory && e.entryName.replace(/\\/g, '/').endsWith('/ffmpeg.exe'))
  if (!entry) throw new Error('ffmpeg.exe not found in archive')
  writeFileSync(dest, entry.getData())
  try {
    // @ts-ignore
    await import('node:fs').then((fs) => fs.promises.unlink(zipPath))
  } catch {
    /* ignore */
  }
  console.log('  ffmpeg.exe OK')
}

function destSizeOk(p) {
  try {
    return statSync(p).size > 1000000
  } catch {
    return false
  }
}

// Tesseract traineddata for scanned-page OCR. We use tesseract.js's official
// jsdelivr data packages (@tesseract.js-data/<lang>, "best" integer LSTM) and
// gunzip them into raw .traineddata files that ship inside resources/ocr
// (packaged: <resources>/ocr) so OCR works fully offline.
import { gunzipSync } from 'node:zlib'
import { readFileSync, unlinkSync } from 'node:fs'

const OCR_LANGS = ['eng', 'ara']
const OCR_BASE = (lang) => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int`

async function ensureOcrData() {
  for (const lang of OCR_LANGS) {
    const dest = join(ocrDir, `${lang}.traineddata`)
    if (existsSync(dest) && destSizeOk(dest)) {
      console.log(`  ${lang}.traineddata already present`)
      continue
    }
    const gzPath = join(ocrDir, `${lang}.traineddata.gz`)
    await downloadWithRetry(`${OCR_BASE(lang)}/${lang}.traineddata.gz`, gzPath)
    process.stdout.write(`  decompressing ${lang}.traineddata...\n`)
    writeFileSync(dest, gunzipSync(readFileSync(gzPath)))
    try {
      unlinkSync(gzPath)
    } catch {
      /* ignore */
    }
    console.log(`  ${lang}.traineddata OK`)
  }
}

async function main() {
  console.log('[binaries] preparing runtime binaries in resources/bin')
  try {
    await ensureYtdlp()
  } catch (e) {
    console.warn(`[binaries] WARNING: could not download yt-dlp.exe: ${e.message}`)
    console.warn('          VIDAUD will still build; downloads will fail until you place yt-dlp.exe in resources/bin')
  }
  try {
    await ensureFfmpeg()
  } catch (e) {
    console.warn(`[binaries] WARNING: could not download ffmpeg.exe: ${e.message}`)
    console.warn('          VIDAUD will still build; mp3 conversion / merging will fail until you place ffmpeg.exe in resources/bin')
  }
  console.log('[binaries] preparing OCR language data in resources/ocr')
  try {
    await ensureOcrData()
  } catch (e) {
    console.warn(`[binaries] WARNING: could not download OCR language data: ${e.message}`)
    console.warn('          VIDAUD will still build; scanned-PDF OCR will be unavailable until you place *.traineddata in resources/ocr')
  }
  console.log('[binaries] done')
}

main()
