import { ipcMain, dialog, shell, app, webUtils, clipboard } from 'electron'
import { accessSync, constants, existsSync, readdirSync, statSync, promises as fsPromises, readFileSync } from 'node:fs'
import { basename, extname, join, resolve as pathResolve } from 'node:path'
import type { AdvancedOptions, AppSettings, DownloadRequest, DownloadTask, PlaylistFolderPreview } from '@shared/types'
import { IPC } from '@shared/types'
import { normalizeHistoryStatus } from '@shared/statistics'
import { isFormatId, isVideoFormatId, isAudioFormatId, isImageFormatId } from '@shared/formats'
import { setYtDlpSettingsGetter, getYtDlpVersion, updateYtDlp } from './downloader/ytdlp'
import { BrowserSessionManager } from './cookies/BrowserSessionManager'
import { analyzeWithCache, cancelAnalyze } from './analyzer/AnalyzerManager'
import { FormatManager } from './formats/FormatManager'
import { QueueManager } from './queue/QueueManager'
import { SettingsManager } from './settings/SettingsManager'
import { HistoryManager } from './history/HistoryManager'
import { CompletedManager } from './completed/CompletedManager'
import { WindowController } from './window/WindowController'
import { ConverterManager } from './converter/ConverterManager'
import { PICKER_EXTENSIONS, isConvertibleExtension } from './converter/CapabilityMatrix'
import { playlistFolderName, resolvePlaylistFolderPath } from './utils/files'
import { logger } from './utils/logger'

function isValidUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const u = new URL(value.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function isValidTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function toPageNumber(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? n : 1
}

function toScale(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 1
}

function sanitizeAdvanced(raw: unknown): AdvancedOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const a = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const out: AdvancedOptions = {}
  if (typeof a.videoCodec === 'string' && a.videoCodec.length <= 40) out.videoCodec = a.videoCodec
  if (typeof a.audioCodec === 'string' && a.audioCodec.length <= 40) out.audioCodec = a.audioCodec
  if (num(a.videoBitrate)) out.videoBitrate = num(a.videoBitrate)
  if (num(a.audioBitrate)) out.audioBitrate = num(a.audioBitrate)
  if (num(a.fps)) out.fps = num(a.fps)
  if (num(a.resolution)) out.resolution = num(a.resolution)
  if (num(a.sampleRate)) out.sampleRate = num(a.sampleRate)
  if (num(a.channels)) out.channels = num(a.channels)
  if (num(a.crf)) out.crf = num(a.crf)
  if (typeof a.preset === 'string' && a.preset.length <= 24) out.preset = a.preset
  if (num(a.pdfDpi)) out.pdfDpi = num(a.pdfDpi)
  if (num(a.pdfQuality)) out.pdfQuality = num(a.pdfQuality)
  if (a.pdfPageRangeMode === 'all' || a.pdfPageRangeMode === 'range') out.pdfPageRangeMode = a.pdfPageRangeMode
  if (num(a.pdfPageRangeStart)) out.pdfPageRangeStart = num(a.pdfPageRangeStart)
  if (num(a.pdfPageRangeEnd)) out.pdfPageRangeEnd = num(a.pdfPageRangeEnd)
  if (typeof a.pdfPassword === 'string' && a.pdfPassword.length <= 200) out.pdfPassword = a.pdfPassword
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeDownloadRequest(raw: unknown): DownloadRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isValidUrl(r.url)) return null
  const kind = r.kind === 'audio' ? 'audio' : r.kind === 'image' ? 'image' : 'video'
  const rawFormat = typeof r.format === 'string' ? r.format.toLowerCase() : ''
  const defaultFormat = kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'jpg'
  const format = rawFormat ? rawFormat : defaultFormat
  // Enforce kind/format coherence so the backend and validation stay consistent.
  const formatKindOk =
    kind === 'image'
      ? isImageFormatId(format)
      : isFormatId(format) && (kind === 'video' ? isVideoFormatId(format) : isAudioFormatId(format))
  const quality = typeof r.quality === 'string' ? r.quality.slice(0, 32) : 'best'
  const advanced = sanitizeAdvanced(r.advanced)
  const entries = Array.isArray(r.entries)
    ? r.entries
        .slice(0, 2000)
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        // Excluded / invalid entries must never reach the download queue: a
        // stable id, a valid URL and a real title are all required.
        .filter((e) => {
          const id = typeof e.id === 'string' && e.id.trim().length > 0
          const rawUrl = typeof e.url === 'string' ? e.url.trim() : ''
          const hasUrl = rawUrl.length > 0 && isValidUrl(rawUrl)
          const avail = e.available !== false
          const title = typeof e.title === 'string' ? e.title.trim() : ''
          const low = title.toLowerCase()
          const hasTitle = title.length > 0 && low !== 'untitled' && low !== 'unknown'
          return id && hasUrl && avail && hasTitle
        })
        .map((e) => {
          const rawUrl = typeof e.url === 'string' ? e.url.trim() : ''
          const title = typeof e.title === 'string' ? e.title.trim() : ''
          return {
            id: typeof e.id === 'string' ? e.id : '',
            url: rawUrl,
            title,
            index: typeof e.index === 'number' ? e.index : undefined,
            duration: typeof e.duration === 'number' ? e.duration : undefined,
            thumbnail: typeof e.thumbnail === 'string' ? e.thumbnail : undefined,
            uploader: typeof e.uploader === 'string' ? e.uploader : undefined,
            available: true,
            error: undefined
          }
        })
    : undefined
  if (entries && entries.length === 0) return null
  return {
    url: r.url,
    kind,
    format: formatKindOk ? format : defaultFormat,
    quality,
    advanced,
    title: typeof r.title === 'string' ? r.title : undefined,
    thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : undefined,
    duration: typeof r.duration === 'number' ? r.duration : undefined,
    uploader: typeof r.uploader === 'string' ? r.uploader : undefined,
    uploadDate: typeof r.uploadDate === 'string' ? r.uploadDate : undefined,
    playlistId: typeof r.playlistId === 'string' ? r.playlistId : undefined,
    playlistTitle: typeof r.playlistTitle === 'string' ? r.playlistTitle : undefined,
    playlistUrl: typeof r.playlistUrl === 'string' ? r.playlistUrl : undefined,
    playlistCount: typeof r.playlistCount === 'number' && r.playlistCount > 0 ? r.playlistCount : undefined,
    downloadFolder: typeof r.downloadFolder === 'string' ? r.downloadFolder : undefined,
    entries
  }
}

const FOLDER_DIALOG_I18N: Record<string, { title: string; use: string; newNumbered: string; cancel: string; message: string }> = {
  en: {
    title: 'Playlist folder already exists',
    use: 'Use existing folder',
    newNumbered: 'Create new numbered folder',
    cancel: 'Cancel',
    message: 'A folder with this playlist name already exists.'
  },
  ar: {
    title: 'مجلد قائمة التشغيل موجود بالفعل',
    use: 'استخدام المجلد الموجود',
    newNumbered: 'إنشاء مجلد مرقّم جديد',
    cancel: 'إلغاء',
    message: 'يوجد بالفعل مجلد بنفس اسم قائمة التشغيل هذه.'
  },
  fr: {
    title: 'Le dossier de la playlist existe déjà',
    use: 'Utiliser le dossier existant',
    newNumbered: 'Créer un dossier numéroté',
    cancel: 'Annuler',
    message: 'Un dossier portant ce nom de playlist existe déjà.'
  }
}

/**
 * Decide where a playlist download goes. Honors the `playlistFolderConflict`
 * setting; in `ask` mode a native dialog is shown so the user can choose.
 * Returns the resolved folder path or null when the user cancels.
 */
async function resolvePlaylistFolderForRequest(req: DownloadRequest, settings: SettingsManager): Promise<string | null> {
  const cfg = settings.get()
  const title = cfg.usePlaylistTitleInFolder ? req.playlistTitle || req.title || '' : ''
  const name = playlistFolderName(title)
  const primary = join(cfg.downloadFolder, name)
  if (!existsSync(primary)) return primary
  if (cfg.playlistFolderConflict === 'use-existing') return primary
  if (cfg.playlistFolderConflict === 'new-numbered') {
    return resolvePlaylistFolderPath(cfg.downloadFolder, title, 'new-numbered').path
  }
  // ask
  const i18n = FOLDER_DIALOG_I18N[cfg.language] ?? FOLDER_DIALOG_I18N.en
  const res = await dialog.showMessageBox({
    type: 'question',
    buttons: [i18n.use, i18n.newNumbered, i18n.cancel],
    defaultId: 0,
    cancelId: 2,
    title: i18n.title,
    message: `${i18n.message} (${name})`,
    detail: cfg.downloadFolder
  })
  if (res.response === 2) return null
  if (res.response === 0) return primary
  return resolvePlaylistFolderPath(cfg.downloadFolder, title, 'new-numbered').path
}

export function registerIpc(queue: QueueManager, settings: SettingsManager, history: HistoryManager, completed: CompletedManager, windowController: WindowController, converter: ConverterManager): void {
  setYtDlpSettingsGetter(() => settings.get())

  ipcMain.handle(IPC.analyze, async (_e, rawUrl: unknown, forceNoCookies?: unknown) => {
    if (!isValidUrl(rawUrl)) {
      return { type: 'unknown', title: '', webpageUrl: String(rawUrl ?? ''), entries: [], availableHeights: [], hasVideo: false, hasAudio: false, error: 'The link is invalid or not supported.' }
    }
    try {
      const ttl = forceNoCookies ? 0 : settings.get().analyzeCacheTtlMinutes
      const options = forceNoCookies === true ? { forceNoCookies: true } : {}
      return await analyzeWithCache(rawUrl.trim(), ttl, options)
    } catch (e) {
      // DownloadFailure (image/web-image pipeline) carries a specific,
      // actionable message — never replace it with the generic fallback.
      // Only errors without any message get 'Unable to analyze this link.'
      const msg = e instanceof Error && e.message ? e.message : 'Unable to analyze this link.'
      logger.warn(`analyze failed: ${msg}`)
      return { type: 'unknown', title: '', webpageUrl: rawUrl.trim(), entries: [], availableHeights: [], hasVideo: false, hasAudio: false, error: msg }
    }
  })

  ipcMain.handle(IPC.getDetectedBrowsers, () => {
    return BrowserSessionManager.getInstance().getDetectedBrowsers()
  })

  ipcMain.handle(IPC.getBrowserProfiles, (_e, browserId: unknown) => {
    const bId = typeof browserId === 'string' ? browserId : 'auto'
    const customPath = settings.get().customBrowserProfilePath
    return BrowserSessionManager.getInstance().getBrowserProfiles(bId, customPath)
  })

  ipcMain.handle(IPC.getYtDlpVersion, () => {
    return getYtDlpVersion()
  })

  ipcMain.handle(IPC.updateYtDlp, () => {
    return updateYtDlp()
  })

  ipcMain.handle(IPC.chooseProfileFolder, async () => {
    const res = await dialog.showOpenDialog({ title: 'Select Browser Profile Folder', properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return { path: null }
    return { path: res.filePaths[0] }
  })

  ipcMain.handle(IPC.cancelAnalyze, (_e, rawUrl: unknown) => {
    if (isValidUrl(rawUrl)) cancelAnalyze(rawUrl.trim())
  })

  // Secure clipboard read: the sandboxed renderer cannot touch the Windows
  // clipboard directly, so it asks the main process over IPC. Only leading /
  // trailing whitespace is trimmed here — the URL itself is never modified.
  ipcMain.handle(IPC.readClipboardText, () => {
    try {
      const text = clipboard.readText().trim()
      if (text.length > 0) return { success: true, text, empty: false }
      // Distinguish "nothing copied" from "something non-textual copied".
      const formats = clipboard.availableFormats()
      const hasNonText = formats.length > 0 && !formats.includes('text/plain')
      return { success: true, text: '', empty: !hasNonText, hasNonText }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unable to read clipboard.'
      logger.warn(`[VIDAUD] Clipboard read failed: ${message}`)
      return { success: false, text: '', empty: false, error: message }
    }
  })

  ipcMain.handle(IPC.getFormats, () => FormatManager.getInstance().listFormats())

  ipcMain.handle(IPC.resolvePlaylistFolder, (_e, rawTitle: unknown): PlaylistFolderPreview => {
    const cfg = settings.get()
    const title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : ''
    const name = playlistFolderName(cfg.usePlaylistTitleInFolder ? title : '')
    return { name, folder: join(cfg.downloadFolder, name) }
  })

  ipcMain.handle(IPC.download, async (_e, raw: unknown) => {
    const req = sanitizeDownloadRequest(raw)
    if (!req) return { ok: false, taskIds: [], error: 'Invalid download request.' }
    if (req.playlistUrl && req.entries && req.entries.length > 1 && settings.get().createPlaylistFolder) {
      const folder = await resolvePlaylistFolderForRequest(req, settings)
      if (!folder) return { ok: false, taskIds: [], error: 'Download cancelled.' }
      req.downloadFolder = folder
    }
    return queue.addRequest(req)
  })

  ipcMain.handle(IPC.pause, (_e, id: unknown) => {
    if (isValidTaskId(id)) queue.pause(id)
  })
  ipcMain.handle(IPC.resume, (_e, id: unknown) => {
    if (isValidTaskId(id)) queue.resume(id)
  })
  ipcMain.handle(IPC.cancel, (_e, id: unknown) => {
    if (isValidTaskId(id)) queue.cancel(id)
  })
  ipcMain.handle(IPC.retry, (_e, id: unknown) => {
    if (isValidTaskId(id)) queue.retry(id)
  })
  ipcMain.handle(IPC.retryPlaylistItem, (_e, playlistId: unknown, itemId: unknown) => {
    if (isValidTaskId(playlistId) && isValidTaskId(itemId)) queue.retryPlaylistItem(playlistId, itemId)
  })
  ipcMain.handle(IPC.retryPlaylistFailed, (_e, playlistId: unknown) => {
    if (isValidTaskId(playlistId)) return queue.retryPlaylistFailed(playlistId)
    return 0
  })
  ipcMain.handle(IPC.getPlaylists, () => queue.getPlaylists())
  ipcMain.handle(IPC.remove, (_e, id: unknown) => {
    if (isValidTaskId(id)) queue.remove(id)
  })
  ipcMain.handle(IPC.pauseAll, () => queue.pauseAll())
  ipcMain.handle(IPC.resumeAll, () => queue.resumeAll())
  ipcMain.handle(IPC.cancelAll, () => queue.cancelAll())
  ipcMain.handle(IPC.removePlaylist, (_e, playlistId: unknown) => {
    if (typeof playlistId === 'string' && playlistId.length > 0) {
      queue.removePlaylist(playlistId)
      return { success: true }
    }
    return { success: false }
  })
  ipcMain.handle(IPC.clearCompleted, () => queue.clearCompleted())
  ipcMain.handle(IPC.clearCompletedDownloads, async () => {
    try {
      const result = await queue.clearCompleted()
      const win = windowController.getWindow()
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(IPC.events.downloadsClearedCompleted, result.removedIds)
      }
      return result
    } catch (error) {
      return {
        success: false,
        removedIds: [],
        count: 0,
        error: error instanceof Error ? error.message : 'Failed to clear completed downloads'
      }
    }
  })
  ipcMain.handle(IPC.getQueue, () => queue.getQueue())
  ipcMain.handle(IPC.getStats, () => queue.getStats())

  ipcMain.handle(IPC.getSettings, () => settings.get())
  ipcMain.handle(IPC.saveSettings, (_e, raw: unknown) => {
    const next: AppSettings = raw && typeof raw === 'object' ? (raw as AppSettings) : settings.get()
    const saved = settings.save(next)
    logger.info('settings updated via IPC')
    return saved
  })

  ipcMain.handle(IPC.getHistory, () => history.list())
  ipcMain.handle(IPC.addHistoryItem, (_e, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const e = raw as Record<string, unknown>
    if (typeof e.fileName !== 'string' || e.fileName.length === 0) return
    const status = normalizeHistoryStatus(e.status) ?? 'completed'
    return history.add({
      fileName: e.fileName,
      type: e.type === 'audio' ? 'audio' : e.type === 'image' ? 'image' : 'video',
      size: Number(e.size) || 0,
      status,
      path: typeof e.path === 'string' ? e.path : '',
      url: typeof e.url === 'string' ? e.url : '',
      source: e.source === 'converter' ? 'converter' : 'download',
      playlistId: typeof e.playlistId === 'string' ? e.playlistId : undefined,
      playlistTitle: typeof e.playlistTitle === 'string' ? e.playlistTitle : undefined,
      playlistIndex: Number(e.playlistIndex) || undefined,
      playlistCount: Number(e.playlistCount) || undefined
    })
  })
  const DELETE_ALL_HISTORY_I18N: Record<string, { title: string; message: string; detail: string; ok: string; cancel: string }> = {
    en: {
      title: 'Delete all download history?',
      message: 'Delete all download history?',
      detail: 'This will remove all History records. Your downloaded files will NOT be deleted.',
      ok: 'Delete All',
      cancel: 'Cancel'
    },
    ar: {
      title: 'حذف سجل التنزيلات بالكامل؟',
      message: 'حذف جميع سجلات التنزيلات؟',
      detail: 'سيؤدي هذا إلى إزالة جميع سجلات الـ History فقط. لن يتم حذف أي ملفات تم تنزيلها.',
      ok: 'حذف الكل',
      cancel: 'إلغاء'
    },
    fr: {
      title: 'Supprimer tout l\'historique ?',
      message: 'Supprimer tout l\'historique des téléchargements ?',
      detail: 'Cela supprimera tous les enregistrements d\'historique. Vos fichiers téléchargés ne seront PAS supprimés.',
      ok: 'Tout supprimer',
      cancel: 'Annuler'
    }
  }

  const handleConfirmDeleteAllHistory = async (): Promise<boolean> => {
    if (process.env['VIDAUD_SMOKE_HISTORY'] === '1') return true
    const win = windowController.getWindow()
    const i18n = DELETE_ALL_HISTORY_I18N[settings.get().language] ?? DELETE_ALL_HISTORY_I18N.en
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: [i18n.ok, i18n.cancel],
      defaultId: 1,
      cancelId: 1,
      title: i18n.title,
      message: i18n.message,
      detail: i18n.detail
    }
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return res.response === 0
  }

  const handleClearHistory = () => {
    try {
      logger.info('[VIDAUD][HISTORY] Delete All requested')
      const before = history.list().length
      history.clear()
      logger.info(`[VIDAUD][HISTORY] Records deleted: ${before}`)
      logger.info('[VIDAUD][HISTORY] Store is now empty')
      const win = windowController.getWindow()
      if (win) {
        win.webContents.send('history-cleared')
        win.webContents.send(IPC.events.historyCleared)
        win.webContents.send(IPC.events.history, [])
      }
      return { success: true, count: before }
    } catch (e) {
      return { success: false, count: 0, error: e instanceof Error ? e.message : 'Failed to delete history' }
    }
  }

  ipcMain.handle(IPC.clearHistory, handleClearHistory)
  ipcMain.handle('history:delete-all', handleClearHistory)
  ipcMain.handle('history:confirm-delete-all', handleConfirmDeleteAllHistory)
  ipcMain.handle(IPC.deleteHistoryItem, (_e, id: unknown) => {
    if (typeof id === 'string' && id.length > 0) {
      const removed = history.remove(id)
      logger.info(`[VIDAUD][HISTORY] delete item ${id} -> ${removed ? 'removed' : 'not found'}`)
      return { success: removed }
    }
    return { success: false }
  })

  // ---------------------------------------------------------------------------
  // Completed library (persistent, local-only)
  // ---------------------------------------------------------------------------
  ipcMain.handle(IPC.getCompleted, () => completed.list())
  ipcMain.handle(IPC.removeCompleted, (_e, id: unknown) => {
    if (typeof id === 'string' && id.length > 0) {
      return { success: completed.remove(id) }
    }
    return { success: false }
  })
  ipcMain.handle(IPC.deleteCompletedFile, (_e, id: unknown) => {
    if (typeof id === 'string' && id.length > 0) {
      const res = completed.deleteFile(id)
      return { success: res.removed }
    }
    return { success: false }
  })
  ipcMain.handle(IPC.removeMissingCompleted, () => {
    const count = completed.removeMissing()
    return { success: true, count }
  })
  const DELETE_ALL_COMPLETED_I18N: Record<string, { title: string; message: string; detail: string; ok: string; cancel: string }> = {
    en: {
      title: 'Delete all completed items?',
      message: 'Delete all items from Completed?',
      detail: 'This will remove all Completed records only. Your downloaded files will NOT be deleted.',
      ok: 'Delete All',
      cancel: 'Cancel'
    },
    ar: {
      title: 'حذف جميع العناصر المكتملة؟',
      message: 'حذف جميع العناصر من المكتملة؟',
      detail: 'سيؤدي هذا إلى إزالة جميع سجلات المكتملة فقط. لن يتم حذف الملفات التي تم تنزيلها.',
      ok: 'حذف الكل',
      cancel: 'إلغاء'
    },
    fr: {
      title: 'Supprimer tous les éléments terminés ?',
      message: 'Supprimer tous les éléments de Terminés ?',
      detail: 'Cela supprimera uniquement les enregistrements de Terminés. Vos fichiers téléchargés ne seront PAS supprimés.',
      ok: 'Tout supprimer',
      cancel: 'Annuler'
    }
  }

  const handleConfirmDeleteAllCompleted = async (): Promise<boolean> => {
    if (process.env['VIDAUD_SMOKE_COMPLETED'] === '1') return true
    const win = windowController.getWindow()
    const i18n = DELETE_ALL_COMPLETED_I18N[settings.get().language] ?? DELETE_ALL_COMPLETED_I18N.en
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: [i18n.ok, i18n.cancel],
      defaultId: 1,
      cancelId: 1,
      title: i18n.title,
      message: i18n.message,
      detail: i18n.detail
    }
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return res.response === 0
  }

  const handleClearAllCompleted = () => {
    try {
      logger.info('[VIDAUD][COMPLETED] Delete All requested')
      const before = completed.list().length
      completed.clearAll()
      logger.info(`[VIDAUD][COMPLETED] Records deleted: ${before}`)
      logger.info('[VIDAUD][COMPLETED] Store is now empty')
      const win = windowController.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.events.completed, [])
      }
      return { success: true, count: before }
    } catch (e) {
      return { success: false, count: 0, error: e instanceof Error ? e.message : 'Failed to delete completed items' }
    }
  }

  // The IPC constants ARE these literal strings; registering the same channel
  // twice would throw "Attempted to register a second handler", so register
  // each channel exactly once.
  ipcMain.handle(IPC.deleteAllCompleted, handleClearAllCompleted)
  ipcMain.handle(IPC.confirmDeleteAllCompleted, handleConfirmDeleteAllCompleted)
  const DELETE_I18N: Record<string, { title: string; ok: string; cancel: string; message: string }> = {
    en: { title: 'Delete file', ok: 'Delete File', cancel: 'Cancel', message: 'Delete this file from your computer? This cannot be undone.' },
    ar: { title: 'حذف الملف', ok: 'حذف الملف', cancel: 'إلغاء', message: 'حذف هذا الملف من جهازك؟ لا يمكن التراجع عن هذا.' },
    fr: { title: 'Supprimer le fichier', ok: 'Supprimer', cancel: 'Annuler', message: 'Supprimer ce fichier de votre ordinateur ? Cette action est irréversible.' }
  }
  ipcMain.handle(IPC.confirmDeleteFile, async (_e, rawName: unknown) => {
    const i18n = DELETE_I18N[settings.get().language] ?? DELETE_I18N.en
    const res = await dialog.showMessageBox({
      type: 'warning',
      buttons: [i18n.ok, i18n.cancel],
      defaultId: 1,
      cancelId: 1,
      title: i18n.title,
      message: i18n.message,
      detail: typeof rawName === 'string' ? rawName : ''
    })
    return res.response === 0
  })

  ipcMain.handle(IPC.chooseFolder, async () => {
    const res = await dialog.showOpenDialog({ title: 'Choose Download Folder', properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return { path: null }
    const folder = res.filePaths[0]
    try {
      if (!statSync(folder).isDirectory()) return { path: null, error: 'The selected path is not a folder.' }
      accessSync(folder, constants.W_OK)
    } catch {
      return { path: null, error: 'The selected folder cannot be used for downloads.' }
    }
    return { path: folder }
  })

  ipcMain.handle(IPC.getDefaultDownloadFolder, () => app.getPath('downloads'))

  ipcMain.handle(IPC.downloadsOpenFolder, async () => {
    const folderPath = settings.get().downloadFolder?.trim()
    if (!folderPath) {
      return { success: false, error: 'Download folder is not configured.' }
    }
    try {
      const resolved = pathResolve(folderPath)
      await fsPromises.mkdir(resolved, { recursive: true })
      const error = await shell.openPath(resolved)
      if (error) {
        logger.error(`[VIDAUD][DOWNLOADS] Unable to open configured download folder: ${error}`)
        return { success: false, error: error || 'Unable to open download folder.' }
      }
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to open download folder.'
      logger.error(`[VIDAUD][DOWNLOADS] Failed to open configured download folder: ${message}`)
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IPC.openFile, async (_e, rawPath: unknown) => {
    if (!rawPath || typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      logger.error('[VIDAUD][COMPLETED] Play requested: Invalid file path')
      return { success: false, error: 'Invalid file path' }
    }
    const filePath = pathResolve(rawPath.trim())
    logger.info(`[VIDAUD][COMPLETED] Play requested: ${filePath}`)
    try {
      await fsPromises.access(filePath)
      logger.info(`[VIDAUD][COMPLETED] File exists = true`)
    } catch {
      logger.error(`[VIDAUD][ERROR] File not found: ${filePath}`)
      return { success: false, error: 'File not found' }
    }
    logger.info(`[VIDAUD][COMPLETED] Opening file: ${filePath}`)
    const openErr = await shell.openPath(filePath)
    if (openErr) {
      logger.error(`[VIDAUD][ERROR] shell.openPath failed: ${openErr}`)
      return { success: false, error: openErr }
    }
    return { success: true }
  })

  ipcMain.handle(IPC.openFolder, async (_e, rawPath: unknown) => {
    const candidate = typeof rawPath === 'string' ? rawPath.trim() : ''
    const target = candidate || settings.get().downloadFolder
    if (!target) {
      logger.error('[VIDAUD][COMPLETED] Open folder requested: no path configured')
      return { success: false, error: 'Download folder is not configured.' }
    }
    const resolved = pathResolve(target)
    logger.info(`[VIDAUD][COMPLETED] Open path requested for: ${resolved}`)
    try {
      await fsPromises.mkdir(resolved, { recursive: true })
      const error = await shell.openPath(resolved)
      if (error) {
        logger.error(`[VIDAUD][ERROR] shell.openPath failed: ${error}`)
        return { success: false, error: error || 'Unable to open folder.' }
      }
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to open folder.'
      logger.error(`[VIDAUD][ERROR] Open folder failed: ${message}`)
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IPC.locateFile, async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return { success: false, error: 'Invalid item ID' }
    const res = await dialog.showOpenDialog({ title: 'Locate File', properties: ['openFile'] })
    if (res.canceled || res.filePaths.length === 0) return { success: false, error: 'Cancelled' }
    const newPath = res.filePaths[0]
    const updated = completed.updateFilePath(id, newPath)
    if (updated) {
      logger.info(`[VIDAUD][COMPLETED] Located and updated path for item ${id} -> ${newPath}`)
      return { success: true, filePath: newPath }
    }
    return { success: false, error: 'Item not found' }
  })

  ipcMain.handle(IPC.openPath, async (_e, path: unknown) => {
    if (typeof path === 'string' && path.length > 0) {
      const filePath = pathResolve(path.trim())
      if (existsSync(filePath)) {
        void shell.openPath(filePath)
      }
    }
  })

  // ---------------------------------------------------------------------------
  // Converter (universal video/audio/image conversion via the bundled FFmpeg)
  // ---------------------------------------------------------------------------

  /**
   * Walk a directory (bounded depth + file cap) and collect the files the
   * converter can actually open. Folder scans ignore everything else, so a
   * folder full of system files never floods the queue.
   */
  const collectFolderFiles = (dir: string): string[] => {
    const out: string[] = []
    const MAX_DEPTH = 8
    const MAX_FILES = 2000
    const walk = (current: string, depth: number): void => {
      if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        if (out.length >= MAX_FILES) return
        const full = join(current, ent.name)
        try {
          if (ent.isDirectory()) {
            if (!ent.name.startsWith('.')) walk(full, depth + 1)
          } else if (ent.isFile() && isConvertibleExtension(extname(ent.name))) {
            out.push(full)
          }
        } catch {
          /* ignore unreadable entries */
        }
      }
    }
    walk(dir, 0)
    return out
  }

  ipcMain.handle(IPC.converterChooseFiles, async (event) => {
    const res = await dialog.showOpenDialog({
      title: 'Select Files to Convert',
      buttonLabel: 'Add',
      properties: ['openFile', 'multiSelections'],
      filters: [
        // The DEFAULT filter is "All Supported Files" — never Video-only. A
        // user can add videos, audio, images, PDFs, documents and archives in
        // one single selection.
        { name: 'All Supported Files', extensions: PICKER_EXTENSIONS },
        { name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'ts', 'mts', 'm2ts', '3gp', '3g2', 'mpg', 'mpeg', 'vob', 'ogv', 'mxf', 'f4v', 'y4m'] },
        { name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'aifc', 'alac', 'ac3', 'eac3', 'amr', 'mp2', 'au', 'oga', 'ape', 'tta'] },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'svg', 'avif', 'heic', 'heif'] },
        { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'html', 'htm', 'md', 'csv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'epub'] },
        { name: 'Archives', extensions: ['zip', '7z', 'tar', 'gz', 'bz2', 'xz'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return []
    return res.filePaths
  })

  ipcMain.handle(IPC.converterSelectFolder, async (event) => {
    const res = await dialog.showOpenDialog({
      title: 'Select Folder to Convert',
      buttonLabel: 'Add Folder',
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return []
    return collectFolderFiles(res.filePaths[0])
  })

  // Drag & drop: dropped items may be files OR folders. Expand folders into the
  // supported files inside them, keep real files as-is.
  ipcMain.handle(IPC.converterExpandPaths, (_e, raw: unknown) => {
    const paths = Array.isArray(raw)
      ? raw.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : []
    const out: string[] = []
    for (const p of paths) {
      try {
        if (!existsSync(p)) continue
        if (statSync(p).isDirectory()) {
          out.push(...collectFolderFiles(p))
        } else {
          out.push(p)
        }
      } catch {
        /* ignore unreadable paths */
      }
    }
    return out
  })

  ipcMain.handle(IPC.converterGetPathForFile, (_e, file: unknown) => {
    if (!file || typeof file !== 'object') return ''
    try {
      return webUtils.getPathForFile(file as File)
    } catch {
      return ''
    }
  })

  ipcMain.handle(IPC.converterGetThumbnail, (_e, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) return null
    return converter.getThumbnail(rawPath)
  })

  ipcMain.handle(IPC.converterDetect, async (event, rawPaths: unknown) => {
    const paths = Array.isArray(rawPaths)
      ? rawPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
    if (paths.length === 0) return []
    // Report real per-file progress so the UI can show "Adding files… 25/100".
    return converter.detectMany(paths, (done, total) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.events.converterDetectProgress, { done, total })
      }
    })
  })

  ipcMain.handle(IPC.converterConvert, (_e, raw: unknown) => {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const items = Array.isArray(r.items)
      ? r.items
          .filter((i): i is { path: string; targetId: string; advanced?: unknown } =>
            !!i && typeof i === 'object' &&
            typeof (i as { path?: unknown }).path === 'string' &&
            typeof (i as { targetId?: unknown }).targetId === 'string')
          .map((i) => ({
            path: i.path,
            targetId: i.targetId,
            advanced: sanitizeAdvanced((i as { advanced?: unknown }).advanced)
          }))
      : undefined
    if (items && items.length > 0) return converter.addRequests(items)
    const paths = Array.isArray(r.paths)
      ? r.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
    const targetId = typeof r.targetId === 'string' ? r.targetId : ''
    return converter.addRequests(paths.map((path) => ({ path, targetId })))
  })

  ipcMain.handle(IPC.converterGetJobs, () => converter.getJobs())
  ipcMain.handle(IPC.converterCancel, (_e, id: unknown) => {
    if (typeof id === 'string' && id.length > 0) converter.cancel(id)
  })
  ipcMain.handle(IPC.converterRetry, (_e, id: unknown) => {
    if (typeof id === 'string' && id.length > 0) converter.retry(id)
  })
  ipcMain.handle(IPC.converterClearFinished, () => converter.clearFinished())
  ipcMain.handle(IPC.converterClearAll, () => converter.clearAll())

  const handleMinimize = () => {
    logger.info('[VIDAUD][WINDOW] Minimize requested')
    if (!windowController.minimize()) {
      return { success: false, error: 'Window unavailable' }
    }
    logger.info('[VIDAUD][WINDOW] Minimize executed')
    return { success: true }
  }
  ipcMain.handle(IPC.windowMinimize, handleMinimize)
  ipcMain.handle('window:minimize', handleMinimize)

  const handleToggleMaximize = () => {
    logger.info('[VIDAUD][WINDOW] Maximize requested')
    const maximized = windowController.toggleMaximize()
    windowController.notifyStateChanged()
    logger.info(`[VIDAUD][WINDOW] Maximize executed -> maximized=${maximized}`)
    return { success: true, maximized }
  }
  ipcMain.handle(IPC.windowMaximize, handleToggleMaximize)
  ipcMain.handle('window:maximize', handleToggleMaximize)
  ipcMain.handle('window:toggle-maximize', handleToggleMaximize)

  const CLOSE_I18N: Record<string, { title: string; message: string; close: string; cancel: string }> = {
    en: { title: 'Downloads are still running', message: 'Downloads are still running. Do you want to close VIDAUD?', close: 'Close Application', cancel: 'Cancel' },
    ar: { title: 'التنزيلات لا تزال تعمل', message: 'التنزيلات لا تزال تعمل. هل تريد إغلاق VIDAUD؟', close: 'إغلاق التطبيق', cancel: 'إلغاء' },
    fr: { title: 'Des téléchargements sont en cours', message: 'Des téléchargements sont en cours. Voulez-vous fermer VIDAUD?', close: 'Fermer l\'application', cancel: 'Annuler' }
  }

  const handleClose = async (confirmed = false) => {
    logger.info('[VIDAUD][WINDOW] Close requested')
    const win = windowController.getWindow()
    if (!win) {
      return { success: false, error: 'Window unavailable' }
    }
    if (queue.hasActiveDownloads()) {
      if (!confirmed) {
        const i18n = CLOSE_I18N[settings.get().language] ?? CLOSE_I18N.en
        const res = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: [i18n.close, i18n.cancel],
          defaultId: 1,
          cancelId: 1,
          title: i18n.title,
          message: i18n.message
        })
        if (res.response !== 0) return { success: false, cancelled: true }
      }
      queue.cancelAll()
      await new Promise<void>((r) => setTimeout(r, 400))
    }
    windowController.close()
    logger.info('[VIDAUD][WINDOW] Close executed')
    return { success: true }
  }
  ipcMain.handle(IPC.windowClose, (_e, confirmed: unknown) => handleClose(confirmed === true))
  ipcMain.handle('window:close', (_e, confirmed: unknown) => handleClose(confirmed === true))

  const handleIsMaximized = () => {
    const maximized = windowController.isMaximized()
    return { success: true, maximized }
  }
  ipcMain.handle(IPC.windowIsMaximized, handleIsMaximized)
  ipcMain.handle('window:is-maximized', handleIsMaximized)
  ipcMain.handle('window:isMaximized', handleIsMaximized)

  // cleanup on quit is handled in main index; nothing else needed here
}
