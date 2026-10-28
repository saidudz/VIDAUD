import { BrowserWindow } from 'electron'
import { logger } from '../utils/logger'

/**
 * Single owner of all window-level operations for VIDADU.
 *
 * Every window action (minimize / maximize / restore / close) must go through
 * this controller so the renderer, preload and IPC stay decoupled from the
 * actual BrowserWindow instance and we never rely on fragile lookups like
 * `BrowserWindow.getFocusedWindow()`.
 */
export class WindowController {
  private win: BrowserWindow

  constructor(win: BrowserWindow) {
    this.win = win
  }

  /** Rebind a freshly created window (used when the window is re-created). */
  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  getWindow(): BrowserWindow | null {
    return !this.win.isDestroyed() ? this.win : null
  }

  minimize(): boolean {
    if (this.win.isDestroyed()) return false
    this.win.minimize()
    return true
  }

  toggleMaximize(): boolean {
    if (this.win.isDestroyed()) return false
    if (this.win.isMaximized()) {
      this.win.unmaximize()
    } else {
      this.win.maximize()
    }
    return this.win.isMaximized()
  }

  isMaximized(): boolean {
    return !this.win.isDestroyed() && this.win.isMaximized()
  }

  close(): void {
    if (!this.win.isDestroyed()) {
      this.win.close()
    }
  }

  /** Broadcast the current maximize state to the renderer. */
  notifyStateChanged(): void {
    if (this.win.isDestroyed()) return
    const maximized = this.win.isMaximized()
    logger.info(`[VIDAUD][WINDOW] state changed -> maximized=${maximized}`)
    this.win.webContents.send('window-state-changed', { maximized })
  }

  /** Emit events used by legacy listeners (vidaud.onWindowMaximized). */
  emitMaximizedEvents(): void {
    if (this.win.isDestroyed()) return
    const maximized = this.win.isMaximized()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('window-state-changed', { maximized })
    }
  }
}
