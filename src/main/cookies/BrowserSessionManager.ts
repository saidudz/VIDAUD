import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, BrowserProfile, DetectedBrowser } from '@shared/types'
import { logger } from '../utils/logger'

export interface SupportedBrowserDef {
  id: string
  name: string
  ytDlpKey: string
  winPaths: string[]
}

const SUPPORTED_BROWSERS: SupportedBrowserDef[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    ytDlpKey: 'chrome',
    winPaths: [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : ''
    ]
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    ytDlpKey: 'edge',
    winPaths: [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data') : ''
    ]
  },
  {
    id: 'chromium',
    name: 'Chromium',
    ytDlpKey: 'chromium',
    winPaths: [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Chromium', 'User Data') : ''
    ]
  },
  {
    id: 'brave',
    name: 'Brave Browser',
    ytDlpKey: 'brave',
    winPaths: [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data') : ''
    ]
  },
  {
    id: 'firefox',
    name: 'Mozilla Firefox',
    ytDlpKey: 'firefox',
    winPaths: [
      process.env.APPDATA ? join(process.env.APPDATA, 'Mozilla', 'Firefox', 'Profiles') : ''
    ]
  },
  {
    id: 'opera',
    name: 'Opera',
    ytDlpKey: 'opera',
    winPaths: [
      process.env.APPDATA ? join(process.env.APPDATA, 'Opera Software', 'Opera Stable') : '',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Opera Software', 'Opera Stable') : ''
    ]
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    ytDlpKey: 'vivaldi',
    winPaths: [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Vivaldi', 'User Data') : ''
    ]
  },
  {
    id: 'whale',
    name: 'Naver Whale',
    ytDlpKey: 'whale',
    winPaths: [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Naver', 'Naver Whale', 'User Data') : ''
    ]
  }
]

export class BrowserSessionManager {
  private static instance: BrowserSessionManager

  /**
   * Set once the browser cookie database proves unreadable (locked by the
   * running browser / app-bound encryption). Once set, the app stops passing
   * `--cookies-from-browser` for the rest of the session so every yt-dlp call
   * goes straight to the (working) no-cookie path instead of failing the
   * cookie copy on EVERY invocation and double-downloading everything.
   */
  private cookieDbUnavailable = false

  public static getInstance(): BrowserSessionManager {
    if (!BrowserSessionManager.instance) {
      BrowserSessionManager.instance = new BrowserSessionManager()
    }
    return BrowserSessionManager.instance
  }

  public setCookieDbUnavailable(): void {
    this.cookieDbUnavailable = true
  }

  public isCookieDbUnavailable(): boolean {
    return this.cookieDbUnavailable
  }

  /**
   * Detects installed browsers on the system.
   */
  public getDetectedBrowsers(): DetectedBrowser[] {
    const list: DetectedBrowser[] = [
      { id: 'auto', name: 'Auto Detect', isInstalled: true }
    ]

    for (const b of SUPPORTED_BROWSERS) {
      const isInstalled = b.winPaths.some((p) => p.length > 0 && existsSync(p))
      list.push({
        id: b.id,
        name: b.name,
        isInstalled
      })
    }

    list.push({ id: 'custom', name: 'Custom Profile Path', isInstalled: true })
    return list
  }

  /**
   * Finds available profiles for a given browser.
   */
  public getBrowserProfiles(browserId: string, customPath?: string): BrowserProfile[] {
    if (browserId === 'custom' && customPath && existsSync(customPath)) {
      return [{ id: 'custom', name: 'Custom Folder', path: customPath }]
    }

    const b = SUPPORTED_BROWSERS.find((item) => item.id === browserId)
    if (!b) {
      return [{ id: 'Default', name: 'Default' }]
    }

    const userDataDir = b.winPaths.find((p) => p.length > 0 && existsSync(p))
    if (!userDataDir) {
      return [{ id: 'Default', name: 'Default' }]
    }

    const profiles: BrowserProfile[] = []

    try {
      if (browserId === 'firefox') {
        const items = readdirSync(userDataDir, { withFileTypes: true })
        for (const item of items) {
          if (item.isDirectory()) {
            profiles.push({ id: item.name, name: item.name, path: join(userDataDir, item.name) })
          }
        }
      } else {
        const items = readdirSync(userDataDir, { withFileTypes: true })
        for (const item of items) {
          if (item.isDirectory()) {
            if (item.name === 'Default' || /^Profile \d+$/i.test(item.name)) {
              profiles.push({ id: item.name, name: item.name, path: join(userDataDir, item.name) })
            }
          }
        }
      }
    } catch (e) {
      logger.warn(`Failed to read profiles for ${browserId}: ${e}`)
    }

    if (profiles.length === 0) {
      profiles.push({ id: 'Default', name: 'Default' })
    }

    return profiles
  }

  /**
   * Constructs yt-dlp arguments for browser cookies.
   * Format: `--cookies-from-browser BROWSER[+KEYRING][:PROFILE][::CONTAINER]`
   */
  public getCookiesArgs(settings?: Partial<AppSettings>, forceNoCookies = false): string[] {
    if (forceNoCookies || !settings || settings.useBrowserSession === false || this.cookieDbUnavailable) {
      return []
    }

    const browserName = settings.browserName || 'auto'
    const profile = settings.browserProfile || 'Default'
    const customPath = settings.customBrowserProfilePath || ''

    if (browserName === 'custom' && customPath && existsSync(customPath)) {
      return ['--cookies-from-browser', `chrome:${customPath}`]
    }

    if (browserName === 'auto') {
      const targetProfile = profile && profile !== 'Default' ? `:${profile}` : ''
      return ['--cookies-from-browser', `chrome${targetProfile}`]
    }

    const targetBrowser = SUPPORTED_BROWSERS.find((b) => b.id === browserName)?.ytDlpKey || browserName
    const targetProfile = profile && profile !== 'Default' ? `:${profile}` : ''
    return ['--cookies-from-browser', `${targetBrowser}${targetProfile}`]
  }

  /**
   * Checks if an error string/output indicates a Cookie database copy/read error.
   */
  public isCookieError(text: string): boolean {
    const low = text.toLowerCase()
    return (
      low.includes('could not copy chrome cookie database') ||
      low.includes('cookie database') ||
      low.includes('cookies-from-browser') ||
      low.includes('permissionerror: [errno 13]') ||
      low.includes('database is locked') ||
      low.includes('unable to extract cookies') ||
      low.includes('sqlite3.operationalerror') ||
      low.includes('failed to decrypt cookies')
    )
  }

  /**
   * Logs sanitized diagnostic information about cookie extraction without leaking sensitive data.
   */
  public logSanitizedStatus(browser: string, profile: string, dbState: string, reason?: string): void {
    logger.info(`[VIDAUD][COOKIES] Browser: ${browser}`)
    logger.info(`[VIDAUD][COOKIES] Profile: ${profile}`)
    logger.info(`[VIDAUD][COOKIES] Database: ${dbState}`)
    if (reason) {
      logger.warn(`[VIDAUD][COOKIES] Reason: ${reason}`)
    }
  }
}
