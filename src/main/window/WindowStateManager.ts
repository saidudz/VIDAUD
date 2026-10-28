import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { logger } from '../utils/logger'

/**
 * Persisted geometry of the main window. `maximized` records whether the
 * window was maximized when the app closed; x/y/width/height hold the normal
 * (restored) bounds so a Maximized window can be restored and a Normal window
 * can reopen at exactly the same spot on the next launch.
 */
export interface WindowState {
  maximized: boolean
  x?: number
  y?: number
  width?: number
  height?: number
}

/** First launch opens Maximized (the required default). */
const DEFAULT_STATE: WindowState = { maximized: true }

function isUsableBounds(bounds: Rectangle): boolean {
  if (bounds.width < 200 || bounds.height < 100) return false
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const overlapW = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x)
    const overlapH = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y)
    return overlapW > 100 && overlapH > 100
  })
}

/**
 * Single owner of the window's persisted geometry. Reads/writes a tiny JSON
 * file next to the app settings so the window never flashes a small frame and
 * always reopens in the state it was closed in (Maximized by default).
 */
export class WindowStateManager {
  private file: string
  private state: WindowState

  constructor() {
    const userData = app.getPath('userData')
    if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
    this.file = join(userData, 'window-state.json')
    this.state = this.load()
  }

  private load(): WindowState {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, unknown>
        const state: WindowState = {
          maximized: raw.maximized !== false,
          x: typeof raw.x === 'number' ? raw.x : undefined,
          y: typeof raw.y === 'number' ? raw.y : undefined,
          width: typeof raw.width === 'number' ? raw.width : undefined,
          height: typeof raw.height === 'number' ? raw.height : undefined
        }
        if (state.width && state.height && isUsableBounds({ x: state.x ?? 0, y: state.y ?? 0, width: state.width, height: state.height })) {
          return state
        }
        return { maximized: state.maximized }
      }
    } catch (e) {
      logger.error(`[VIDAUD][WINDOW] state load failed: ${e}`)
    }
    return { ...DEFAULT_STATE }
  }

  get(): WindowState {
    return { ...this.state }
  }

  /** Snapshot the live window geometry + maximize flag and persist it. */
  capture(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    this.state = {
      maximized: win.isMaximized(),
      ...win.getNormalBounds()
    }
    try {
      writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf-8')
      logger.info(`[VIDAUD][WINDOW] state saved -> maximized=${this.state.maximized}`)
    } catch (e) {
      logger.error(`[VIDAUD][WINDOW] state save failed: ${e}`)
    }
  }
}
