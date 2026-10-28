// Integration smoke test: exercises the exact yt-dlp + ffmpeg pipeline used by VIDAUD.
// Usage: node scripts/smoke-test.mjs [url]
import { spawnSync, spawn } from 'node:child_process'
import { mkdirSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const bin = join(__dirname, '..', 'resources', 'bin')
const tmp = join(__dirname, '..', '.smoke-test')
const testUrl = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const yt = join(bin, 'yt-dlp.exe')
const ff = join(bin, 'ffmpeg.exe')
let passed = 0
let failed = 0

function ok(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  [PASS] ${name}`)
  } else {
    failed++
    console.log(`  [FAIL] ${name} ${extra}`)
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('close', (code) => resolve({ code, out }))
  })
}

function filesMatching(dir, prefix) {
  return readdirSync(dir).filter((f) => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl'))
}

// VIDAUD has no ffprobe binary: stream info is parsed from `ffmpeg -i` output.
function ffmpegStreams(file) {
  const res = spawnSync(ff, ['-hide_banner', '-i', file], { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 })
  const streams = []
  for (const line of String(res.stderr || '').split('\n')) {
    const m = line.match(/^\s*Stream #0:\d+.*?\b(Audio|Video|Data|Subtitle|Attachment):\s*([\w-]+)/)
    if (m) streams.push({ type: m[1], codec: m[2] })
  }
  return streams
}

async function ytDlpDownload(format, outTemplate, extraArgs = []) {
  const args = [
    '--no-warnings', '--newline', '--no-playlist', '--no-mtime', '--no-color',
    '--concurrent-fragments', '4', '--retries', '3', '--fragment-retries', '5',
    '--socket-timeout', '30', '-f', format, '--paths', tmp, '-o', outTemplate,
    ...extraArgs, testUrl
  ]
  return run(yt, args)
}

async function main() {
  console.log(`Smoke test against: ${testUrl}`)

  console.log('\n[1] Analyze')
  const info = spawnSync(yt, ['--no-warnings', '--playlist-items', '1', '-J', testUrl], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  const parsed = info.status === 0 ? JSON.parse(info.stdout) : null
  ok('analysis returns title', !!parsed?.title, info.stderr.slice(0, 200))
  ok('analysis returns formats', Array.isArray(parsed?.formats) && parsed.formats.length > 0)

  console.log('\n[2] Download video stream (360p)')
  let rv = await ytDlpDownload('bestvideo[height<=360]', 'video.%(ext)s')
  let vFiles = filesMatching(tmp, 'video.')
  if (rv.code !== 0 || vFiles.length === 0) {
    // Fallback: combined video+audio stream (mirrors VIDAUD's fallback path)
    rv = await ytDlpDownload('best[height<=360]/best', 'video.%(ext)s')
    vFiles = filesMatching(tmp, 'video.')
  }
  ok('video stream downloaded', rv.code === 0 && vFiles.length > 0, `code=${rv.code}`)

  console.log('\n[3] Download audio stream')
  const ra = await ytDlpDownload('bestaudio[ext=m4a]/bestaudio/best', 'audio.%(ext)s', ['--write-thumbnail'])
  const aFiles = filesMatching(tmp, 'audio.')
  const thumb = readdirSync(tmp).find((f) => /\.(webp|jpg|png)$/i.test(f))
  ok('audio stream downloaded', ra.code === 0 && aFiles.length > 0, `code=${ra.code}`)
  ok('thumbnail written', !!thumb)

  const videoFile = vFiles.length > 0 ? join(tmp, vFiles[0]) : null
  const audioFile = join(tmp, aFiles[0])

  console.log('\n[3a] FFprobe downloaded audio BEFORE conversion (mirrors verifyDownloadedAudio)')
  const probeIn = await run(ff, ['-v', 'error', '-i', audioFile, '-map', '0:a:0', '-t', '5', '-f', 'null', '-'])
  ok('downloaded audio has a decodable audio stream', probeIn.code === 0, probeIn.out.slice(-300))
  const audioTypes = ffmpegStreams(audioFile)
  ok('downloaded audio stream is NOT a video-only/image file', audioTypes.some((s) => s.type === 'Audio'), `streams=${JSON.stringify(audioTypes)}`)

  console.log('\n[3b] Audio-only format selection (bestAudio picked from analyzed formats)')
  const audioInfo = spawnSync(yt, ['--no-warnings', '--playlist-items', '1', '-J', '-f', 'bestaudio[ext=m4a]/bestaudio/best', testUrl], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 })
  const audioParsed = audioInfo.status === 0 ? JSON.parse(audioInfo.stdout) : null
  const fmt = audioParsed?.format_id || ''
  ok('audio-only format selected (format_id present)', typeof fmt === 'string' && fmt.length > 0, audioInfo.stderr.slice(0, 200))

  let outMp4 = null
  console.log('\n[4] Merge to MP4')
  if (!videoFile) {
    console.log('  [SKIP] no video file available (video stream unavailable on this URL)')
  } else {
    outMp4 = join(tmp, 'final.mp4')
    const rm = await run(ff, ['-y', '-i', videoFile, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', outMp4])
    ok('merge succeeded', rm.code === 0 && existsSync(outMp4), rm.out.slice(-300))
    if (existsSync(outMp4)) {
      ok('merged mp4 not empty', statSync(outMp4).size > 1024)
      const probe = await run(ff, ['-v', 'error', '-i', outMp4, '-map', '0', '-t', '5', '-f', 'null', '-'])
      ok('merged mp4 decodes', probe.code === 0, probe.out.slice(-300))
    }
  }

  console.log('\n[5] Convert to MP3 (320kbps) with cover')
  const cover = thumb ? join(tmp, thumb) : null
  const outMp3 = join(tmp, 'final.mp3')
  const mp3Args = ['-y', '-i', audioFile]
  if (cover) mp3Args.push('-i', cover)
  mp3Args.push('-map', '0:a:0')
  if (cover) mp3Args.push('-map', '1:v:0')
  mp3Args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3',
    '-metadata', 'title=Test Track', '-metadata', 'artist=Test Artist')
  if (cover) mp3Args.push('-c:v', 'mjpeg', '-metadata:s:v', 'title=Album cover')
  mp3Args.push(outMp3)
  const rc = await run(ff, mp3Args)
  ok('mp3 conversion succeeded', rc.code === 0 && existsSync(outMp3), rc.out.slice(-300))
  if (existsSync(outMp3)) {
    const probe = await run(ff, ['-v', 'error', '-i', outMp3, '-map', '0', '-t', '5', '-f', 'null', '-'])
    ok('mp3 decodes', probe.code === 0, probe.out.slice(-300))
    const streams = ffmpegStreams(outMp3)
    ok('final mp3 audio codec is mp3', streams.some((s) => s.type === 'Audio' && s.codec.includes('mp3')), JSON.stringify(streams))
  }

  console.log('\n[6] Remux fallback (combined stream) keeps audio')
  if (!outMp4) {
    console.log('  [SKIP] no merged mp4 available to remux')
  } else {
    const rm2 = await run(ff, ['-y', '-i', outMp4, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', join(tmp, 'final2.mp4')])
    ok('remux succeeded', rm2.code === 0 && existsSync(join(tmp, 'final2.mp4')), rm2.out.slice(-200))
    if (existsSync(join(tmp, 'final2.mp4'))) {
      const probe2 = await run(ff, ['-v', 'error', '-i', join(tmp, 'final2.mp4'), '-map', '0:a:0', '-t', '5', '-f', 'null', '-'])
      ok('remuxed mp4 retains decodable audio', probe2.code === 0, probe2.out.slice(-200))
    }
  }

  console.log('\n[7] Playlist detection')
  const pl = spawnSync(yt, ['--no-warnings', '--flat-playlist', '--playlist-items', '1-5', '-J', 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 })
  const plParsed = pl.status === 0 ? JSON.parse(pl.stdout) : null
  ok('playlist analysis', plParsed?._type === 'playlist' || (Array.isArray(plParsed?.entries) && plParsed.entries.length > 1), pl.stderr.slice(0, 200))

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('smoke test crashed', e)
  process.exit(1)
})
