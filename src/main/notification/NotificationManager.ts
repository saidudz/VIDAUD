import { BrowserWindow, Notification } from 'electron'
import type { NotificationPayload } from '@shared/types'

export class NotificationManager {
  show(payload: NotificationPayload): void {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: payload.title, body: payload.body, silent: false })
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        win.webContents.send('vidaud:notification:click', payload)
      }
    })
    n.show()
  }
}
