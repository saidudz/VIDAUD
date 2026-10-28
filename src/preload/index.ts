import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type {
  VidaudApi,
  ClipboardReadResult,
  ElectronApi,
  DownloadTask,
  DownloadProgressPayload,
  FormatInfo,
  StatsSummary,
  HistoryEntry,
  CompletedItem,
  AppSettings,
  MediaInfo,
  DownloadRequest,
  NotificationPayload,
  PlaylistFolderPreview,
  PlaylistJob,
  FolderPickResult,
  DetectedFile,
  ConversionRequest,
  ConverterJob,
  ConverterProgressPayload,
  ConverterDetectProgress
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: VidaudApi = {
  analyze: (url: string, forceNoCookies?: boolean) => ipcRenderer.invoke(IPC.analyze, url, forceNoCookies) as Promise<MediaInfo>,
  cancelAnalyze: (url: string) => ipcRenderer.invoke(IPC.cancelAnalyze, url) as Promise<void>,
  getFormats: () => ipcRenderer.invoke(IPC.getFormats) as Promise<{ video: FormatInfo[]; audio: FormatInfo[] }>,
  download: (request: DownloadRequest) => ipcRenderer.invoke(IPC.download, request) as Promise<{ ok: boolean; taskIds: string[]; error?: string }>,
  resolvePlaylistFolder: (title: string) => ipcRenderer.invoke(IPC.resolvePlaylistFolder, title) as Promise<PlaylistFolderPreview>,
  pause: (id: string) => ipcRenderer.invoke(IPC.pause, id) as Promise<void>,
  resume: (id: string) => ipcRenderer.invoke(IPC.resume, id) as Promise<void>,
  cancel: (id: string) => ipcRenderer.invoke(IPC.cancel, id) as Promise<void>,
  retry: (id: string) => ipcRenderer.invoke(IPC.retry, id) as Promise<void>,
  retryPlaylistItem: (playlistId: string, itemId: string) => ipcRenderer.invoke(IPC.retryPlaylistItem, playlistId, itemId) as Promise<void>,
  retryPlaylistFailed: (playlistId: string) => ipcRenderer.invoke(IPC.retryPlaylistFailed, playlistId) as Promise<number>,
  remove: (id: string) => ipcRenderer.invoke(IPC.remove, id) as Promise<void>,
  pauseAll: () => ipcRenderer.invoke(IPC.pauseAll) as Promise<void>,
  resumeAll: () => ipcRenderer.invoke(IPC.resumeAll) as Promise<void>,
  cancelAll: () => ipcRenderer.invoke(IPC.cancelAll) as Promise<void>,
  clearCompleted: () => ipcRenderer.invoke(IPC.clearCompleted) as Promise<{ success: boolean; removedIds: string[]; count: number; error?: string }>,
  removePlaylist: (playlistId: string) => ipcRenderer.invoke(IPC.removePlaylist, playlistId) as Promise<{ success: boolean }>,
  getQueue: () => ipcRenderer.invoke(IPC.getQueue) as Promise<DownloadTask[]>,
  getStats: () => ipcRenderer.invoke(IPC.getStats) as Promise<StatsSummary>,
  getPlaylists: () => ipcRenderer.invoke(IPC.getPlaylists) as Promise<PlaylistJob[]>,
  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<AppSettings>,
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke(IPC.saveSettings, settings) as Promise<AppSettings>,
  getHistory: () => ipcRenderer.invoke(IPC.getHistory) as Promise<HistoryEntry[]>,
  addHistoryItem: (entry) => ipcRenderer.invoke(IPC.addHistoryItem, entry) as Promise<HistoryEntry>,
  clearHistory: () => ipcRenderer.invoke(IPC.clearHistory) as Promise<{ success: boolean; count: number }>,
  deleteAllHistory: () => ipcRenderer.invoke('history:delete-all') as Promise<{ success: boolean; count: number; error?: string }>,
  confirmDeleteAllHistory: () => ipcRenderer.invoke('history:confirm-delete-all') as Promise<boolean>,
  deleteHistoryItem: (id: string) => ipcRenderer.invoke(IPC.deleteHistoryItem, id) as Promise<{ success: boolean }>,
  getCompleted: () => ipcRenderer.invoke(IPC.getCompleted) as Promise<CompletedItem[]>,
  removeCompleted: (id: string) => ipcRenderer.invoke(IPC.removeCompleted, id) as Promise<{ success: boolean }>,
  deleteCompletedFile: (id: string) => ipcRenderer.invoke(IPC.deleteCompletedFile, id) as Promise<{ success: boolean }>,
  removeMissingCompleted: () => ipcRenderer.invoke(IPC.removeMissingCompleted) as Promise<{ success: boolean; count: number }>,
  deleteAllCompleted: () => ipcRenderer.invoke('completed:delete-all') as Promise<{ success: boolean; count: number; error?: string }>,
  confirmDeleteAllCompleted: () => ipcRenderer.invoke('completed:confirm-delete-all') as Promise<boolean>,
  confirmDeleteFile: (fileName: string) => ipcRenderer.invoke(IPC.confirmDeleteFile, fileName) as Promise<boolean>,
  chooseFolder: () => ipcRenderer.invoke(IPC.chooseFolder) as Promise<FolderPickResult>,
  getDefaultDownloadFolder: () => ipcRenderer.invoke(IPC.getDefaultDownloadFolder) as Promise<string>,
  openDownloadFolder: () => ipcRenderer.invoke(IPC.downloadsOpenFolder) as Promise<{ success: boolean; error?: string }>,
  openFolder: (filePath: string) => ipcRenderer.invoke(IPC.openFolder, filePath) as Promise<{ success: boolean; error?: string }>,
  openFile: (filePath: string) => ipcRenderer.invoke(IPC.openFile, filePath) as Promise<{ success: boolean; error?: string }>,
  locateFile: (id: string) => ipcRenderer.invoke(IPC.locateFile, id) as Promise<{ success: boolean; filePath?: string; error?: string }>,
  openPath: (path: string) => ipcRenderer.invoke(IPC.openPath, path) as Promise<void>,
  windowMinimize: () => ipcRenderer.invoke('window:minimize') as Promise<void>,
  windowMaximize: () => ipcRenderer.invoke('window:toggle-maximize') as Promise<void>,
  windowClose: (confirmed?: boolean) => ipcRenderer.invoke('window:close', confirmed) as Promise<void>,
  windowIsMaximized: async () => {
    const res = (await ipcRenderer.invoke('window:is-maximized')) as { success: boolean; maximized: boolean }
    return res?.maximized ?? false
  },
  getDetectedBrowsers: () => ipcRenderer.invoke(IPC.getDetectedBrowsers) as Promise<Array<{ id: string; name: string; isInstalled: boolean }>>,
  getBrowserProfiles: (browserId: string) => ipcRenderer.invoke(IPC.getBrowserProfiles, browserId) as Promise<Array<{ id: string; name: string; path?: string }>>,
  getYtDlpVersion: () => ipcRenderer.invoke(IPC.getYtDlpVersion) as Promise<string>,
  updateYtDlp: () => ipcRenderer.invoke(IPC.updateYtDlp) as Promise<{ success: boolean; version?: string; error?: string }>,
  chooseProfileFolder: () => ipcRenderer.invoke(IPC.chooseProfileFolder) as Promise<FolderPickResult>,
  onQueue: (cb) => subscribe<DownloadTask[]>(IPC.events.queue, cb),
  onStats: (cb) => subscribe<StatsSummary>(IPC.events.stats, cb),
  onStatistics: (cb) => subscribe<StatsSummary>(IPC.events.statistics, cb),
  onHistory: (cb) => subscribe<HistoryEntry[]>(IPC.events.history, cb),
  onHistoryCleared: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('history-cleared', listener)
    ipcRenderer.on(IPC.events.historyCleared, listener)
    return () => {
      ipcRenderer.removeListener('history-cleared', listener)
      ipcRenderer.removeListener(IPC.events.historyCleared, listener)
    }
  },
  onNotify: (cb) => subscribe<NotificationPayload>(IPC.events.notify, cb),
  onDownloadProgress: (cb) => subscribe<DownloadProgressPayload>(IPC.events.progress, cb),
  onPlaylists: (cb) => subscribe<PlaylistJob[]>(IPC.events.playlists, cb),
  onDownloadsClearedCompleted: (cb) => subscribe<string[]>(IPC.events.downloadsClearedCompleted, cb),
  onAnalyzeProgress: (cb) => subscribe<{ url: string; done: number; total: number }>(IPC.events.analyzeProgress, cb),
  onCompleted: (cb) => subscribe<CompletedItem[]>(IPC.events.completed, cb),
  onWindowMaximized: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.events.windowMaximized, listener)
    return () => { ipcRenderer.removeListener(IPC.events.windowMaximized, listener) }
  },
  onWindowUnmaximized: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.events.windowUnmaximized, listener)
    return () => { ipcRenderer.removeListener(IPC.events.windowUnmaximized, listener) }
  },
  onWindowStateChanged: (cb: (state: { maximized: boolean }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: { maximized: boolean }): void => cb(s)
    ipcRenderer.on('window-state-changed', listener)
    return () => { ipcRenderer.removeListener('window-state-changed', listener) }
  },
  selectFiles: () => ipcRenderer.invoke(IPC.converterChooseFiles) as Promise<string[]>,
  selectFolder: () => ipcRenderer.invoke(IPC.converterSelectFolder) as Promise<string[]>,
  expandPaths: (paths: string[]) => ipcRenderer.invoke(IPC.converterExpandPaths, paths) as Promise<string[]>,
  getPathForFile: (file: File) => ipcRenderer.invoke(IPC.converterGetPathForFile, file) as Promise<string>,
  getFileThumbnail: (path: string) => ipcRenderer.invoke(IPC.converterGetThumbnail, path) as Promise<string | null>,
  detectFiles: (paths: string[]) => ipcRenderer.invoke(IPC.converterDetect, paths) as Promise<DetectedFile[]>,
  convertFiles: (request: ConversionRequest) => ipcRenderer.invoke(IPC.converterConvert, request) as Promise<{ ok: boolean; error?: string; added?: number; unavailable?: number }>,
  getConverterJobs: () => ipcRenderer.invoke(IPC.converterGetJobs) as Promise<ConverterJob[]>,
  cancelConversion: (id: string) => ipcRenderer.invoke(IPC.converterCancel, id) as Promise<void>,
  retryConversion: (id: string) => ipcRenderer.invoke(IPC.converterRetry, id) as Promise<void>,
  clearFinishedConversions: () => ipcRenderer.invoke(IPC.converterClearFinished) as Promise<void>,
  clearAllConversions: () => ipcRenderer.invoke(IPC.converterClearAll) as Promise<void>,
  onConverterJobs: (cb) => subscribe<ConverterJob[]>(IPC.events.converterJobs, cb),
  onConverterProgress: (cb) => subscribe<ConverterProgressPayload>(IPC.events.converterProgress, cb),
  onConverterDetectProgress: (cb) => subscribe<ConverterDetectProgress>(IPC.events.converterDetectProgress, cb)
}

const electronAPI: ElectronApi = {
  readClipboardText: () => ipcRenderer.invoke(IPC.readClipboardText) as Promise<ClipboardReadResult>,
  minimizeWindow: () => ipcRenderer.invoke('window:minimize') as Promise<{ success: boolean; error?: string }>,
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize') as Promise<{ success: boolean; maximized: boolean; error?: string }>,
  closeWindow: (confirmed?: boolean) => ipcRenderer.invoke('window:close', confirmed) as Promise<{ success: boolean; cancelled?: boolean; error?: string }>,
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<{ success: boolean; maximized: boolean; error?: string }>,
  onWindowStateChanged: (cb: (state: { maximized: boolean }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: { maximized: boolean }): void => cb(s)
    ipcRenderer.on('window-state-changed', listener)
    return () => { ipcRenderer.removeListener('window-state-changed', listener) }
  },
  clearCompletedDownloads: () => ipcRenderer.invoke(IPC.clearCompletedDownloads) as Promise<{ success: boolean; removedIds: string[]; count: number; error?: string }>,
  deleteAllHistory: () => ipcRenderer.invoke('history:delete-all') as Promise<{ success: boolean; count: number; error?: string }>,
  confirmDeleteAllHistory: () => ipcRenderer.invoke('history:confirm-delete-all') as Promise<boolean>,
  deleteAllCompleted: () => ipcRenderer.invoke('completed:delete-all') as Promise<{ success: boolean; count: number; error?: string }>,
  confirmDeleteAllCompleted: () => ipcRenderer.invoke('completed:confirm-delete-all') as Promise<boolean>,
  onHistoryCleared: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('history-cleared', listener)
    ipcRenderer.on(IPC.events.historyCleared, listener)
    return () => {
      ipcRenderer.removeListener('history-cleared', listener)
      ipcRenderer.removeListener(IPC.events.historyCleared, listener)
    }
  }
}

contextBridge.exposeInMainWorld('vidaud', api)
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

