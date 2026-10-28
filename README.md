VIDADU

**Video & Audio Downloader for Windows**

VIDAUD is a Windows desktop application built with Electron, Vite, React, and TypeScript. It provides a single interface for analyzing supported media links, managing download tasks, organizing completed downloads, and converting local files when the required conversion tools are available.

> **Project status:** This repository contains the application source code. For a ready-to-install Windows build, check the [GitHub Releases](https://github.com/saidudz/VIDAUD/releases) page. If no release is published yet, a downloadable installer may not be available there.

![VIDAUD logo](Logo.png)

## Features

### Media downloads

- Paste a supported URL and analyze it before downloading.
- Download supported video as **MP4** and audio as **MP3**.
- Select available video quality, including 1080p, 720p, 480p, and 360p when offered by the source.
- Configure MP3 bitrate options: 128, 192, 256, or 320 kbps.
- Download supported playlists and queue multiple items.
- View download progress, percentage, speed, estimated time remaining, and technical details when available.

Availability and quality depend on the source website, network access, and the formats it provides. Some links may be unavailable, region-restricted, authentication-protected, or unsupported.

### Download queue and task management

- Pause, resume, retry, cancel, and remove download tasks.
- Configure the maximum number of simultaneous downloads.
- Resume interrupted tasks when the application supports recovery; interrupted tasks may be restored as paused.
- Choose how existing files are handled, such as renaming, replacing, or skipping them, according to the available settings.
- Clear completed tasks and manage downloads from the Downloads and Completed sections.

### History

- Keep a persistent record of download activity.
- Search and filter previous tasks where supported by the current interface.

### Settings

- Choose the download folder.
- Configure video quality and MP3 bitrate.
- Set concurrent download limits and retry behavior.
- Configure automatic downloads, notifications, and other available preferences.
- Choose from the available interface languages: English, Arabic (RTL), and French.

### Converter

VIDAUD includes a Converter interface for supported local-file conversions. Available formats and operations depend on the conversion engine and tools configured in the application. A format should be considered supported only when the installed build provides the required processing capability.

## Download and install

1. Open [VIDAUD Releases](https://github.com/saidudz/VIDAUD/releases).
2. Choose the latest stable release, if one is available.
3. Download the Windows installer provided with that release (for example, a `VIDAUD-Setup-*.exe` file).
4. Run the installer and follow the on-screen instructions.

Only download installers from the official VIDADU repository or another distribution location you trust.

## System requirements

- Windows 10 or Windows 11, 64-bit.
- An internet connection for online media downloads and update checks.
- Some conversion and media-processing features rely on bundled or configured tools such as FFmpeg and yt-dlp.

## Development setup

### Prerequisites

- Node.js 18 or later (the project has also been tested with Node.js 24, according to the project documentation).
- npm.
- Git, if you plan to clone the repository.

### Clone the repository

```bash
git clone https://github.com/saidudz/VIDAUD.git
cd VIDAUD
```

### Install dependencies

```bash
npm install
```

If the repository lockfile is current and you want a reproducible CI-style installation, use `npm ci` instead.

### Run type checks

```bash
npm run typecheck
```

### Build the application

```bash
npm run build
```

### Run in development mode

```bash
npm run dev
```

The development server requires port **5173** to be available. If a command is not defined in `package.json`, inspect the available scripts with:

```bash
npm run
```

Packaging commands and output directories are defined by the project's current `package.json` and Electron Builder configuration. Check those files for the exact command used to generate the portable executable and NSIS installer.

## Releases and updates

- Source code: [GitHub repository](https://github.com/saidudz/VIDAUD)
- Published versions: [GitHub Releases](https://github.com/saidudz/VIDAUD/releases)

A link to the Releases page does not, by itself, provide automatic in-app updates. Automatic updates require a correctly configured updater, a compatible packaged Windows build, and the expected release metadata/assets. Do not assume automatic updates are enabled until they have been implemented and tested against a newer published release.

## Troubleshooting

### A download fails or the source is unavailable

Confirm that the URL is correct and that the source is accessible from your location and account. Some sites restrict downloads, remove content, or change their delivery methods. VIDADU cannot guarantee that every URL or playlist can be downloaded.

### Audio conversion fails

Check that the input contains an audio stream and that the bundled/configured FFmpeg executable is available. Files without an audio stream cannot be converted to MP3 as audio.

### The development server cannot start

Make sure port `5173` is free, install dependencies again if needed, and review the terminal output for the actual error.

### A Windows installer is not listed on GitHub

The repository may contain source code before a packaged release has been published. Check the Releases page for an installer, or build the application using the project's configured packaging scripts.

## Responsible use

Use VIDADU only for content you are authorized to download and process. Respect copyright, website terms, privacy, and access restrictions. Do not use the application to bypass DRM, authentication, or other access controls.

## Security

- **Never commit API keys, access tokens, passwords, browser cookies, private keys, or secret `.env` files.**
- Keep credentials in local environment files or secure secret storage and exclude them from Git with `.gitignore`.
- Review changes before committing or publishing the repository.
- Report security issues privately to the repository maintainer rather than posting secrets or exploit details publicly.

## Contributing

Contributions and bug reports are welcome. Before opening a pull request:

1. Describe the problem or proposed change.
2. Keep changes focused and avoid committing generated binaries or personal data.
3. Run the available type checks and build commands.
4. Include clear reproduction steps for bug fixes.

## License

No license file is currently provided in this repository. Unless a license is added, do not assume that the source code may be redistributed, modified, or reused under an open-source license.
