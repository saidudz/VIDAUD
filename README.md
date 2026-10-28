# VIDAUD

Professional desktop app for Windows that downloads videos and audio from supported sites. Built with Electron + React + TypeScript, powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org/).

## Features

- Paste a URL, analyze it, and download as **MP4 (video)** or **MP3 (audio)**
- Video quality selection: 1080p, 720p, 480p, 360p (best available is selected when the requested height is not available)
- MP3 bitrate: 128/192/256/320 kbps, with title/artist metadata and thumbnail cover art
- **Playlist support**: detect and download all videos in a playlist
- **Download queue**: add multiple items, per-task and global pause/resume/cancel/retry, remove, clear completed
- **Concurrent downloads**: configurable max simultaneous downloads (default 2)
- **Resume**: interrupted tasks are restored as `Paused` on next launch and can be resumed
- **Progress UI**: live progress bar, percentage, speed, ETA, and collapsible technical details
- **History**: full download history with search and filters, persisted to disk
- **Settings**: download folder, video quality, MP3 bitrate, max simultaneous downloads, retry count/delay, auto-start queue, thumbnail saving, notifications, theme (dark/light/system)
- **Multilingual**: English, Arabic (RTL), French
- **Existing file strategy**: rename, replace, or skip
- Packaged as `VIDAUD.exe` (portable) and `VIDAUD-Setup.exe` (NSIS installer)

## Prerequisites (development)

- Windows 10/11 (x64)
- Node.js 18+ (tested with Node 24)

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit for main/preload + renderer
npm run build       # electron-vite build -> out/
npm run dev         # electron-vite dev (HMR)
```

`npm run dev` requires port 5173 to be free.

## Downloading fresh binaries

The runtime binaries live in `resources/bin` and are bundled into the installer via `extraResources`.

```bash
node scripts/download-binaries.mjs   # yt-dlp.exe + ffmpeg.exe with pinned fallbacks
```

If the download fails, place `yt-dlp.exe` and `ffmpeg.exe` manually into `resources/bin`.

## Testing

```bash
node scripts/smoke-test.mjs          # standalone CLI integration test (analyze/download/merge/convert)
```

End-to-end in-app smoke (drives the real queue via IPC, gated by env vars):

```bash
$env:VIDAUD_SMOKE_URL='https://www.youtube.com/watch?v=...'
$env:VIDAUD_SMOKE_KIND='video'    # or 'audio'
$env:VIDAUD_SMOKE_QUALITY='360'   # or mp3 bitrate e.g. 128
$env:VIDAUD_SMOKE_FOLDER='C:\path\to\output'
npx electron .
```

The process exits `0` on success (with the output file path), `1` on download failure, `2` on smoke error.

## Packaging

```bash
npm run package   # npx electron-builder --win
```

Produces:

- `dist/VIDAUD-Setup.exe` — NSIS installer (per-user, no admin required)
- `dist/VIDAUD.exe` — portable single-file app
- `dist/win-unpacked/VIDAUD.exe` — unpacked app

## Project Structure

```
resources/bin/          yt-dlp.exe + ffmpeg.exe (bundled at runtime)
scripts/                icon generator, binary downloader, smoke tests
src/shared/types.ts     shared IPC contract and types (main + preload + renderer)
src/main/               Electron main process (settings, queue, downloader, ffmpeg, history, IPC)
src/preload/            contextBridge API exposed as window.vidaud
src/renderer/           React UI (Dashboard, Downloads, History, Settings, i18n)
electron-builder.yml    packaging config
```

## Security

- `contextIsolation: true`, `sandbox: true`, no `nodeIntegration`
- Renderer only talks to main via a validated, typed IPC API (`window.vidaud`)
- All IPC inputs (URLs, task ids, settings) are validated in `src/main/ipc.ts`

## Legal

Respect the terms of service of the sites you download from, and only download content you have the right to use.
