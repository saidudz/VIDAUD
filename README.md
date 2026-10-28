VIDADU

**Video & Audio Downloader for Windows**

VIDAUD is a Windows desktop application for managing supported video, audio, and playlist downloads, organizing completed files, and converting local media when the required tools and formats are available.

![VIDAUD background and branding]([Url](https://github.com/saidudz/VIDAUD/blob/main/scripts/background.png?raw=true)

## Features

### Video, audio, and playlist downloads

- Paste a supported link and analyze it before downloading.
- Download supported video as MP4 and audio as MP3.
- Choose from quality and bitrate options offered by the source and application.
- Queue multiple tasks and download supported playlists.
- View task progress and technical details when available.

Download availability depends on the source website, network conditions, access permissions, and the formats provided by the source. VIDADU cannot guarantee that every link or playlist will be available.

### Download management

- Pause, resume, retry, or cancel supported download tasks.
- Configure simultaneous downloads and retry behavior.
- Choose how existing files are handled, where the available settings support it.
- Review downloads in the Downloads, Completed, and History sections.

### Settings

- Choose the download folder.
- Configure available video and audio options.
- Set download concurrency and retry preferences.
- Configure available startup, notification, and language preferences.
- Use the available English, Arabic (RTL), and French interface options.

### Converter

VIDAUD includes a Converter interface for supported local-file conversions. Available formats and operations depend on the conversion tools included with or configured for the installed version. Check the options presented by your installed application for the formats it supports.

## Download and install

1. Open the [VIDAUD Releases page](https://github.com/saidudz/VIDAUD/releases).
2. Choose a stable release if one has been published.
3. Download the Windows installer attached to that release, if available.
4. Run the installer and follow the on-screen instructions.

If no release asset is available, a ready-to-install build has not yet been published. Only download installers from the official VIDADU repository or a distribution location you trust.

## System requirements

- Windows 10 or Windows 11 (64-bit).
- An internet connection for online downloads and any configured update checks.
- Some media-processing or conversion features may require tools such as FFmpeg or yt-dlp, depending on the installed build.

## Releases and updates

- **Source repository:** [saidudz/VIDAUD](https://github.com/saidudz/VIDAUD)
- **Download releases:** [VIDAUD Releases](https://github.com/saidudz/VIDAUD/releases)

The Releases page lets users check for published versions and download their attached files. A link to this page does not, by itself, enable automatic updates inside the application; in-app updates require a properly configured updater and compatible release assets. Automatic updating should not be considered available until it has been implemented and tested in a packaged Windows build.

## Troubleshooting

### A download fails or the source is unavailable

Check that the URL is correct and that the content is accessible to you. A website may remove content, restrict access by region, require authentication, or change how it serves media.

### Audio conversion fails

Check that the input contains an audio stream and that the required media-processing tools are available. A file without an audio stream cannot be converted to MP3 as audio.

### The installer is not listed on GitHub

A repository can contain source code before a packaged release has been published. Check the [Releases page](https://github.com/saidudz/VIDAUD/releases) for a Windows installer.

## Responsible use

Use VIDADU only for content you are authorized to download and process. Respect copyright, website terms, privacy, and access restrictions. Do not use the application to bypass DRM, authentication, or other access controls.

## Security

Do not publish API keys, access tokens, passwords, browser cookies, private keys, or secret environment files in a public repository. Review repository files before publishing changes.

## License

No license file is currently provided in this repository. Unless a license is added, do not assume that the source code may be redistributed, modified, or reused under an open-source license.
