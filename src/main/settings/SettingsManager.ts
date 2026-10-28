import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AppSettings } from '@shared/types'
import { isVideoFormatId, isAudioFormatId } from '@shared/formats'
import { logger } from '../utils/logger'

export const defaultSettings: AppSettings = {
  downloadFolder: '',
  createPlaylistFolder: true,
  playlistIndexInFilename: false,
  usePlaylistTitleInFolder: true,
  sanitizeFilenames: true,
  playlistFolderConflict: 'use-existing',
  startAutomatically: true,
  askBeforeStart: false,
  openFolderAfterDownload: false,
  rememberLastSettings: true,
  localDownloadOnly: true,
  defaultVideoFormat: 'mp4',
  defaultVideoQuality: 'best',
  container: 'mp4',
  preferredCodec: 'H.264 + AAC',
  defaultAudioFormat: 'mp3',
  mp3Bitrate: '320',
  embedMetadata: true,
  embedCoverArt: true,
  maxSimultaneousDownloads: 2,
  retryCount: 3,
  retryDelaySeconds: 5,
  maxConcurrentProcessing: 1,
  analyzeCacheTtlMinutes: 10,
  concurrentFragments: 4,
  parallelVideoAudio: true,
  theme: 'dark',
  language: 'en',
  onExistingFile: 'rename',
  converterOutputFolder: '',
  notifications: true,
  useBrowserSession: true,
  browserName: 'auto',
  browserProfile: 'Default',
  customBrowserProfilePath: ''
}

const clampInt = (v: unknown, min: number, max: number, def: number): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

function sanitizeSettings(raw: unknown): AppSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>
  const folder = typeof src.downloadFolder === 'string' ? src.downloadFolder : defaultSettings.downloadFolder
  const validBrowsers = ['auto', 'chrome', 'edge', 'chromium', 'brave', 'firefox', 'opera', 'vivaldi', 'whale', 'custom']
  const browserName = typeof src.browserName === 'string' && validBrowsers.includes(src.browserName) ? src.browserName : 'auto'
  return {
    ...defaultSettings,
    ...src,
    downloadFolder: folder,
    createPlaylistFolder: src.createPlaylistFolder !== false,
    playlistIndexInFilename: src.playlistIndexInFilename === true,
    usePlaylistTitleInFolder: src.usePlaylistTitleInFolder !== false,
    sanitizeFilenames: src.sanitizeFilenames !== false,
    playlistFolderConflict: src.playlistFolderConflict === 'new-numbered' || src.playlistFolderConflict === 'ask' ? src.playlistFolderConflict : 'use-existing',
    startAutomatically: src.startAutomatically !== false,
    askBeforeStart: src.askBeforeStart === true,
    openFolderAfterDownload: src.openFolderAfterDownload === true,
    rememberLastSettings: src.rememberLastSettings !== false,
    localDownloadOnly: src.localDownloadOnly !== false,
    defaultVideoFormat: typeof src.defaultVideoFormat === 'string' && isVideoFormatId(src.defaultVideoFormat) ? src.defaultVideoFormat : 'mp4',
    defaultVideoQuality: typeof src.defaultVideoQuality === 'string' ? src.defaultVideoQuality : defaultSettings.defaultVideoQuality,
    container: typeof src.container === 'string' ? src.container : 'mp4',
    preferredCodec: typeof src.preferredCodec === 'string' ? src.preferredCodec : 'H.264 + AAC',
    defaultAudioFormat: typeof src.defaultAudioFormat === 'string' && isAudioFormatId(src.defaultAudioFormat) ? src.defaultAudioFormat : 'mp3',
    mp3Bitrate: typeof src.mp3Bitrate === 'string' ? src.mp3Bitrate : '320',
    embedMetadata: src.embedMetadata !== false,
    embedCoverArt: src.embedCoverArt !== false,
    maxSimultaneousDownloads: clampInt(src.maxSimultaneousDownloads, 1, 8, 2),
    retryCount: clampInt(src.retryCount, 0, 10, 3),
    retryDelaySeconds: clampInt(src.retryDelaySeconds, 1, 120, 5),
    maxConcurrentProcessing: clampInt(src.maxConcurrentProcessing, 1, 4, 1),
    analyzeCacheTtlMinutes: [5, 10, 30].includes(Number(src.analyzeCacheTtlMinutes)) ? Number(src.analyzeCacheTtlMinutes) : 10,
    concurrentFragments: clampInt(src.concurrentFragments, 1, 16, 4),
    parallelVideoAudio: src.parallelVideoAudio !== false,
    theme: src.theme === 'light' || src.theme === 'system' ? src.theme : 'dark',
    language: typeof src.language === 'string' && src.language.length > 0 ? src.language.slice(0, 8) : 'en',
    onExistingFile: src.onExistingFile === 'replace' || src.onExistingFile === 'skip' ? src.onExistingFile : 'rename',
    converterOutputFolder: typeof src.converterOutputFolder === 'string' ? src.converterOutputFolder.trim() : '',
    notifications: src.notifications !== false,
    useBrowserSession: src.useBrowserSession !== false,
    browserName,
    browserProfile: typeof src.browserProfile === 'string' && src.browserProfile.trim() ? src.browserProfile.trim() : 'Default',
    customBrowserProfilePath: typeof src.customBrowserProfilePath === 'string' ? src.customBrowserProfilePath.trim() : ''
  }
}

export class SettingsManager {
  private settings: AppSettings
  private file: string

  constructor() {
    const userData = app.getPath('userData')
    if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
    this.file = join(userData, 'settings.json')
    this.settings = this.load()
    if (!this.settings.downloadFolder) {
      this.settings.downloadFolder = app.getPath('downloads')
    }
  }

  private load(): AppSettings {
    try {
      if (existsSync(this.file)) {
        return sanitizeSettings(JSON.parse(readFileSync(this.file, 'utf-8')))
      }
    } catch (e) {
      logger.error(`settings load failed: ${e}`)
    }
    return { ...defaultSettings }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  save(next: AppSettings): AppSettings {
    this.settings = sanitizeSettings(next)
    try {
      if (!existsSync(this.settings.downloadFolder)) {
        mkdirSync(this.settings.downloadFolder, { recursive: true })
      }
      writeFileSync(this.file, JSON.stringify(this.settings, null, 2), 'utf-8')
      logger.info('settings saved')
    } catch (e) {
      logger.error(`settings save failed: ${e}`)
    }
    return this.get()
  }
}
