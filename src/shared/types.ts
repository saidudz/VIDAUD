import type { FormatDefinition } from './formats'
export type { FormatStatus, FormatDefinition } from './formats'

export type MediaType = 'video' | 'playlist' | 'image' | 'image-gallery' | 'unknown'
export type DownloadKind = 'video' | 'audio' | 'image'
export type TaskState =
  | 'Waiting'
  | 'Analyzing'
  | 'Downloading'
  | 'Processing'
  | 'Converting'
  | 'Completed'
  | 'Retrying'
  | 'Failed'
  | 'Unavailable'
  | 'Cancelled'
  | 'Paused'
/** Per-playlist-item status. A superset of TaskState, also carried by the persistent job. */
export type ItemStatus = TaskState
export type TaskPhase = 'queued' | 'analyzing' | 'video' | 'audio' | 'download' | 'merge' | 'remux' | 'converting' | 'validation' | 'retry' | 'paused' | 'done'
/**
 * Persistent download/history status. `queued|analyzing|downloading|
 * processing|converting|retrying` are counted as "Active"; `completed` and
 * `failed` are terminal outcomes; `cancelled`/`unavailable` stay independent
 * and are never counted as completed or failed.
 */
export type HistoryStatus =
  | 'queued'
  | 'analyzing'
  | 'downloading'
  | 'processing'
  | 'converting'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unavailable'
export type ThemeMode = 'dark' | 'light' | 'system'
export type ExistingFileAction = 'rename' | 'replace' | 'skip'
export type PlaylistFolderConflict = 'use-existing' | 'new-numbered' | 'ask'
/** Drives the retry policy: temporary failures are retried with backoff, permanent ones are terminal. */
export type ErrorKind = 'temporary' | 'permanent' | 'unknown'

/** Resolved playlist subfolder shown in the analyze UI before the download starts. */
export interface PlaylistFolderPreview {
  name: string
  folder: string
}

/** Why a playlist item was excluded and must never be shown or queued. */
export type ExcludeReason = 'missing_title' | 'invalid_title' | 'missing_url' | 'missing_id' | 'unavailable' | 'invalid_metadata'

export interface MediaEntry {
  id: string
  title: string
  url: string
  index?: number
  duration?: number
  thumbnail?: string
  uploader?: string
  /** Detected image extension (jpg/png/...) for image-gallery entries. */
  format?: string
  /** Image width in px when declared in markup (used for min-size filters). */
  width?: number
  /** Image height in px when declared in markup (used for min-size filters). */
  height?: number
  /** False when the item has no usable URL and can never be downloaded. */
  available?: boolean
  /** Human-readable reason when the item is not available. */
  error?: string
  /** True when the entry was excluded from the playlist (never shown or queued). */
  excluded?: boolean
  /** Internal reason: missing_title | invalid_title | missing_url | missing_id | unavailable | invalid_metadata */
  excludeReason?: ExcludeReason
  /** For image-search results: the original/high-res image URL (may be same as url if unavailable). */
  originalUrl?: string
  /** For image-search results: the source website domain. */
  source?: string
  /** For image-search results: true when the original image URL is accessible, false when only thumbnail is available. */
  originalAvailable?: boolean
  /** For image-search results: the page URL where the image was found. */
  sourcePageUrl?: string
}

export interface MediaInfo {
  type: MediaType
  title: string
  playlistId?: string
  playlistTitle?: string
  thumbnail?: string
  duration?: number
  uploader?: string
  uploadDate?: string
  /** Detected image extension (jpg/png/...) when type === 'image'. */
  imageExt?: string
  /** Known Content-Length in bytes when type === 'image' (may be undefined). */
  fileSize?: number
  /** For type 'image-gallery': 'web' (normal page) or 'search' (image-search page). */
  imageGalleryKind?: 'web' | 'search'
  webpageUrl: string
  /** Total entries detected in the source playlist (including excluded ones). */
  entryCount?: number
  /** Number of entries that are valid and can be downloaded. */
  downloadableCount?: number
  /** Number of entries hidden because they are invalid or unavailable. */
  excludedCount?: number
  truncated?: boolean
  entries: MediaEntry[]
  availableHeights: number[]
  hasVideo: boolean
  hasAudio: boolean
  /**
   * Per-format status computed by the backend after analyze:
   * `direct` (a source stream can be copied/remuxed), `convert` (FFmpeg
   * conversion required and possible), `unavailable` (not supported by source
   * or the bundled FFmpeg).
   */
  formatSupport?: Record<string, 'direct' | 'convert' | 'unavailable'>
  error?: string
}

/** Advanced FFmpeg knobs exposed to advanced users (hidden by default). */
export interface AdvancedOptions {
  videoCodec?: string
  audioCodec?: string
  videoBitrate?: number
  audioBitrate?: number
  fps?: number
  resolution?: number
  sampleRate?: number
  channels?: number
  crf?: number
  preset?: string
  // PDF specific options
  pdfDpi?: number
  pdfQuality?: number
  pdfPageRangeMode?: 'all' | 'range'
  pdfPageRangeStart?: number
  pdfPageRangeEnd?: number
  pdfPassword?: string
}

export interface DownloadRequest {
  url: string
  kind: DownloadKind
  format: string
  quality: string
  title?: string
  thumbnail?: string
  duration?: number
  uploader?: string
  uploadDate?: string
  playlistId?: string
  playlistTitle?: string
  playlistUrl?: string
  playlistCount?: number
  /** Destination folder resolved by the backend for playlist downloads. */
  downloadFolder?: string
  advanced?: AdvancedOptions
  entries?: Array<{ id: string; url: string; title: string; index?: number; duration?: number; thumbnail?: string; uploader?: string; available?: boolean; error?: string; format?: string; width?: number; height?: number }>
}

export interface StreamProgress {
  percent: number
  downloadedBytes: number
  totalBytes?: number
  speedBytes?: number
  etaSeconds?: number
}

export interface TaskProgress {
  percent: number
  indeterminate?: boolean
  speedBytes?: number
  downloadedBytes: number
  totalBytes?: number
  etaSeconds?: number
  phase?: TaskPhase
  stage: string
  message?: string
}

/**
 * High-frequency progress event emitted from main to renderer for a single task.
 * `percent` is null while the real total size is unknown (indeterminate UI).
 */
export interface DownloadProgressPayload {
  id: string
  phase: TaskPhase
  downloadedBytes: number
  totalBytes: number | null
  percent: number | null
  speed: number
  eta: number | null
}

export interface DownloadTask {
  id: string
  uniqueKey: string
  title: string
  url: string
  kind: DownloadKind
  format: string
  quality: string
  thumbnail?: string
  duration?: number
  playlistId?: string
  playlistTitle?: string
  playlistUrl?: string
  playlistIndex?: number
  playlistCount?: number
  /** Stable per-item key inside the playlist (the entry/video id). */
  playlistItemId?: string
  /** Destination folder for this task (playlist downloads use a playlist-named subfolder). */
  downloadFolder?: string
  state: TaskState
  progress: TaskProgress
  error?: string
  errorDetails?: string
  errorKind?: ErrorKind
  filePath?: string
  fileSize?: number
  createdAt: number
  updatedAt: number
  attempt: number
  /** When set (state 'Retrying'), the task becomes schedulable again at this timestamp. */
  retryAt?: number
  tempDir: string
  /**
   * The attempt-scoped temporary directory currently holding this job's
   * partial downloads. Kept stable across Pause -> Resume (and app restarts)
   * so yt-dlp `.part` files are continued with HTTP Range instead of being
   * re-downloaded from 0. Cleared/re-created on a fresh Retry.
   */
  attemptDir?: string
  autoStart?: boolean
}

/**
 * A persistent per-playlist download job. Holds every item and its final status
 * so the UI can show the true total even after completed/failed tasks are
 * removed from the queue (e.g. after an app restart).
 */
export interface PlaylistItem {
  /** Stable item key = the entry id (unique per playlist). */
  itemId: string
  uniqueKey: string
  index: number
  title: string
  url: string
  duration?: number
  thumbnail?: string
  uploader?: string
  /** Live task currently handling this item, when one exists. */
  taskId?: string
  status: ItemStatus
  attempt: number
  retryAt?: number
  error?: string
  errorDetails?: string
  errorKind?: ErrorKind
}

export interface PlaylistJob {
  playlistId: string
  playlistTitle: string
  playlistUrl: string
  totalItems: number
  kind: DownloadKind
  format: string
  quality: string
  advanced?: AdvancedOptions
  downloadFolder?: string
  createdAt: number
  items: PlaylistItem[]
}

export interface PlaylistStats {
  total: number
  queued: number
  analyzing: number
  downloading: number
  completed: number
  retrying: number
  failed: number
  unavailable: number
  cancelled: number
  finished: boolean
}

export interface StatsSummary {
  active: number
  completed: number
  failed: number
  totalBytes: number
}

export interface HistoryEntry {
  id: string
  uniqueKey?: string
  fileName: string
  date: number
  type: 'video' | 'audio' | 'image'
  size: number
  status: HistoryStatus
  path: string
  url: string
  playlistId?: string
  playlistTitle?: string
  playlistIndex?: number
  playlistCount?: number
  /** `converter` when this entry came from the Converter, `download` (default) otherwise. */
  source?: 'download' | 'converter'
}

/**
 * A successfully downloaded file registered in the persistent Completed
 * library. The record points at the local file; the file itself is never
 * moved — only the record lives in the Completed list.
 */
export interface CompletedItem {
  id: string
  uniqueKey?: string
  title: string
  filePath: string
  fileName?: string
  format: string
  type: 'video' | 'audio' | 'image'
  size: number
  completedAt: number
  thumbnail?: string
  quality?: string
  sourceUrl?: string
  playlistId?: string
  playlistTitle?: string
  playlistIndex?: number
  /** `converter` when this item came from the Converter, `download` (default) otherwise. */
  source?: 'download' | 'converter'
  /** Input format of a converted file (e.g. 'mkv'), used for the "Converted from" label. */
  originalFormat?: string
  /** True when the underlying file still exists on disk (computed at read time). */
  exists?: boolean
}

// ---------------------------------------------------------------------------
// Universal Converter
// ---------------------------------------------------------------------------

export type ConverterCategory = 'video' | 'audio' | 'image' | 'pdf' | 'document' | 'unsupported'
export type ConverterState = 'Waiting' | 'Converting' | 'Processing' | 'Completed' | 'Failed' | 'Cancelled'

/** One output target the backend can actually produce (verified against the bundled FFmpeg / engines). */
export interface ConverterTarget {
  id: string
  /** Short display label, e.g. "MP4" or "JPG". */
  label: string
  kind: ConverterCategory
  extension: string
  /** Human-readable codec description (fallback label used in the UI). */
  description: string
  /** Sub-category grouping (e.g. "Image", "Document") for organized menus */
  group?: string
}

/** A file the user dropped/selected, classified by the backend. */
export interface DetectedFile {
  path: string
  name: string
  size: number
  category: ConverterCategory
  /** Lowercased file extension without the dot. */
  extension: string
  probed?: boolean
  hasVideo?: boolean
  hasAudio?: boolean
  width?: number
  height?: number
  duration?: number
  /** Number of pages for PDF documents */
  pageCount?: number
  /** Present when `category === 'unsupported'`. */
  unsupportedReason?: string
  /** Output targets compatible with this file (empty when unsupported). */
  targets: ConverterTarget[]
}

export interface ConverterJob {
  id: string
  inputPath: string
  inputName: string
  inputCategory: ConverterCategory
  targetId: string
  targetLabel: string
  targetExtension: string
  state: ConverterState
  progress: {
    percent: number
    indeterminate?: boolean
    stage: string
    message?: string
  }
  outputPath?: string
  outputName?: string
  /** Number of pages produced by a PDF -> image conversion (1+). */
  pageCount?: number
  error?: string
  errorDetails?: string
  createdAt: number
  updatedAt: number
  attempt: number
}

/** High-frequency progress for a single conversion job. `percent` null = indeterminate. */
export interface ConverterProgressPayload {
  id: string
  percent: number | null
  stage: string
}

export interface ConversionRequest {
  /** Backward-compatible single-target request: all `paths` convert to `targetId`. */
  paths?: string[]
  targetId?: string
  /** Per-file output formats (recommended). Each item may target a different format. */
  items?: { path: string; targetId: string; advanced?: AdvancedOptions }[]
}

/** Per-file progress while the backend classifies a batch of selected files. */
export interface ConverterDetectProgress {
  done: number
  total: number
}


export interface AppSettings {
  downloadFolder: string
  createPlaylistFolder: boolean
  playlistIndexInFilename: boolean
  usePlaylistTitleInFolder: boolean
  sanitizeFilenames: boolean
  playlistFolderConflict: PlaylistFolderConflict
  startAutomatically: boolean
  askBeforeStart: boolean
  openFolderAfterDownload: boolean
  rememberLastSettings: boolean
  /** Local-only mode: files are saved and played back on this computer only.
   *  No upload/publish features are provided regardless of this setting. */
  localDownloadOnly: boolean
  defaultVideoFormat: string
  defaultVideoQuality: string
  container: string
  preferredCodec: string
  defaultAudioFormat: string
  mp3Bitrate: string
  embedMetadata: boolean
  embedCoverArt: boolean
  maxSimultaneousDownloads: number
  retryCount: number
  retryDelaySeconds: number
  maxConcurrentProcessing: number
  analyzeCacheTtlMinutes: number
  concurrentFragments: number
  parallelVideoAudio: boolean
  theme: ThemeMode
  language: string
  onExistingFile: ExistingFileAction
  notifications: boolean
  /** Destination folder for Converter outputs. Empty = fall back to downloadFolder. */
  converterOutputFolder: string
  useBrowserSession: boolean
  browserName: string
  browserProfile: string
  customBrowserProfilePath: string
}

export interface DetectedBrowser {
  id: string
  name: string
  isInstalled: boolean
}

export interface BrowserProfile {
  id: string
  name: string
  path?: string
}

export interface NotificationPayload {
  title: string
  body: string
  clickAction?: 'downloads' | 'folder'
  filePath?: string
}

/** A format definition enriched with runtime FFmpeg capability info. */
export interface FormatInfo extends FormatDefinition {
  /** True when the muxer AND all required default encoders are present in the bundled FFmpeg. */
  available: boolean
  /** True when a conversion (encode) would be required for a generic source. */
  requiresConversion: boolean
}

export const IPC = {
  analyze: 'vidaud:analyze',
  cancelAnalyze: 'vidaud:cancelAnalyze',
  download: 'vidaud:download',
  getFormats: 'vidaud:getFormats',
  resolvePlaylistFolder: 'vidaud:resolvePlaylistFolder',
  pause: 'vidaud:pause',
  resume: 'vidaud:resume',
  cancel: 'vidaud:cancel',
  retry: 'vidaud:retry',
  retryPlaylistItem: 'vidaud:retryPlaylistItem',
  retryPlaylistFailed: 'vidaud:retryPlaylistFailed',
  remove: 'vidaud:remove',
  pauseAll: 'vidaud:pauseAll',
  resumeAll: 'vidaud:resumeAll',
  cancelAll: 'vidaud:cancelAll',
  clearCompleted: 'vidaud:clearCompleted',
  clearCompletedDownloads: 'downloads:clear-completed',
  getQueue: 'vidaud:getQueue',
  getStats: 'vidaud:getStats',
  getPlaylists: 'vidaud:getPlaylists',
  getSettings: 'vidaud:getSettings',
  saveSettings: 'vidaud:saveSettings',
  getHistory: 'vidaud:getHistory',
  addHistoryItem: 'vidaud:addHistoryItem',
  clearHistory: 'vidaud:clearHistory',
  deleteHistoryItem: 'vidaud:deleteHistoryItem',
  getCompleted: 'vidaud:getCompleted',
  removeCompleted: 'vidaud:removeCompleted',
  deleteCompletedFile: 'vidaud:deleteCompletedFile',
  removeMissingCompleted: 'vidaud:removeMissingCompleted',
  deleteAllCompleted: 'completed:delete-all',
  confirmDeleteAllCompleted: 'completed:confirm-delete-all',
  confirmDeleteFile: 'vidaud:confirmDeleteFile',
  chooseFolder: 'vidaud:chooseFolder',
  getDefaultDownloadFolder: 'vidaud:getDefaultDownloadFolder',
  downloadsOpenFolder: 'downloads:open-folder',
  openFolder: 'file:open-folder',
  openFile: 'file:open',
  locateFile: 'file:locate-file',
  openPath: 'vidaud:openPath',
  readClipboardText: 'clipboard:read-text',
  windowMinimize: 'vidaud:window:minimize',
  windowMaximize: 'vidaud:window:maximize',
  windowClose: 'vidaud:window:close',
  windowIsMaximized: 'vidaud:window:isMaximized',
  removePlaylist: 'vidaud:removePlaylist',
  getDetectedBrowsers: 'vidaud:getDetectedBrowsers',
  getBrowserProfiles: 'vidaud:getBrowserProfiles',
  getYtDlpVersion: 'vidaud:getYtDlpVersion',
  updateYtDlp: 'vidaud:updateYtDlp',
  chooseProfileFolder: 'vidaud:chooseProfileFolder',
  converterChooseFiles: 'converter:choose-files',
  converterSelectFolder: 'converter:select-folder',
  converterExpandPaths: 'converter:expand-paths',
  converterGetPathForFile: 'converter:get-path-for-file',
  converterDetect: 'converter:detect',
  converterGetThumbnail: 'converter:get-thumbnail',
  converterConvert: 'converter:convert',
  converterGetJobs: 'converter:get-jobs',
  converterCancel: 'converter:cancel',
  converterRetry: 'converter:retry',
  converterClearFinished: 'converter:clear-finished',
  converterClearAll: 'converter:clear-all',
  events: {
    queue: 'vidaud:events:queue',
    stats: 'vidaud:events:stats',
    statistics: 'vidaud:events:statistics',
    history: 'vidaud:events:history',
    historyCleared: 'vidaud:events:history-cleared',
    notify: 'vidaud:events:notify',
    progress: 'vidaud:events:progress',
    playlists: 'vidaud:events:playlists',
    downloadsClearedCompleted: 'downloads:cleared-completed',
    analyzeProgress: 'vidaud:events:analyze-progress',
    completed: 'vidaud:events:completed',
    windowMaximized: 'vidaud:events:window-maximized',
    windowUnmaximized: 'vidaud:events:window-unmaximized',
    converterJobs: 'converter:events:jobs',
    converterProgress: 'converter:events:progress',
    converterDetectProgress: 'converter:events:detect-progress'
  }
} as const

export interface FolderPickResult {
  path: string | null
  error?: string
}

export interface VidaudApi {
  analyze(url: string, forceNoCookies?: boolean): Promise<MediaInfo>
  cancelAnalyze(url: string): Promise<void>
  getFormats(): Promise<{ video: FormatInfo[]; audio: FormatInfo[] }>
  download(request: DownloadRequest): Promise<{ ok: boolean; taskIds: string[]; error?: string; skipped?: number; unavailable?: number }>
  resolvePlaylistFolder(title: string): Promise<PlaylistFolderPreview>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  cancel(id: string): Promise<void>
  retry(id: string): Promise<void>
  retryPlaylistItem(playlistId: string, itemId: string): Promise<void>
  retryPlaylistFailed(playlistId: string): Promise<number>
  remove(id: string): Promise<void>
  pauseAll(): Promise<void>
  resumeAll(): Promise<void>
  cancelAll(): Promise<void>
  clearCompleted(): Promise<{ success: boolean; removedIds: string[]; count: number; error?: string }>
  removePlaylist(playlistId: string): Promise<{ success: boolean }>
  getQueue(): Promise<DownloadTask[]>
  getStats(): Promise<StatsSummary>
  getPlaylists(): Promise<PlaylistJob[]>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  getHistory(): Promise<HistoryEntry[]>
  addHistoryItem(entry: Omit<HistoryEntry, 'id' | 'date'> & { date?: number }): Promise<HistoryEntry>
  clearHistory(): Promise<{ success: boolean; count: number }>
  deleteHistoryItem(id: string): Promise<{ success: boolean }>
  getCompleted(): Promise<CompletedItem[]>
  removeCompleted(id: string): Promise<{ success: boolean }>
  deleteCompletedFile(id: string): Promise<{ success: boolean }>
  removeMissingCompleted(): Promise<{ success: boolean; count: number }>
  deleteAllCompleted(): Promise<{ success: boolean; count: number; error?: string }>
  confirmDeleteAllCompleted(): Promise<boolean>
  confirmDeleteFile(fileName: string): Promise<boolean>
  confirmDeleteAllHistory(): Promise<boolean>
  deleteAllHistory(): Promise<{ success: boolean; count: number; error?: string }>
  chooseFolder(): Promise<FolderPickResult>
  getDefaultDownloadFolder(): Promise<string>
  openDownloadFolder(): Promise<{ success: boolean; error?: string }>
  openFolder(filePath: string): Promise<{ success: boolean; error?: string }>
  openFile(filePath: string): Promise<{ success: boolean; error?: string }>
  locateFile(id: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  openPath(path: string): Promise<void>
  windowMinimize(): Promise<void>
  windowMaximize(): Promise<void>
  windowClose(confirmed?: boolean): Promise<void>
  windowIsMaximized(): Promise<boolean>
  getDetectedBrowsers(): Promise<DetectedBrowser[]>
  getBrowserProfiles(browserId: string): Promise<BrowserProfile[]>
  getYtDlpVersion(): Promise<string>
  updateYtDlp(): Promise<{ success: boolean; version?: string; error?: string }>
  chooseProfileFolder(): Promise<FolderPickResult>
  onQueue(cb: (tasks: DownloadTask[]) => void): () => void
  onStats(cb: (stats: StatsSummary) => void): () => void
  onStatistics(cb: (stats: StatsSummary) => void): () => void
  onHistory(cb: (entries: HistoryEntry[]) => void): () => void
  onHistoryCleared(cb: () => void): () => void
  onNotify(cb: (payload: NotificationPayload) => void): () => void
  onDownloadProgress(cb: (progress: DownloadProgressPayload) => void): () => void
  onPlaylists(cb: (jobs: PlaylistJob[]) => void): () => void
  onDownloadsClearedCompleted(cb: (removedIds: string[]) => void): () => void
  onAnalyzeProgress(cb: (progress: { url: string; done: number; total: number }) => void): () => void
  onCompleted(cb: (items: CompletedItem[]) => void): () => void
  onWindowMaximized(cb: () => void): () => void
  onWindowUnmaximized(cb: () => void): () => void
  onWindowStateChanged(cb: (state: { maximized: boolean }) => void): () => void
  selectFiles(): Promise<string[]>
  selectFolder(): Promise<string[]>
  expandPaths(paths: string[]): Promise<string[]>
  getPathForFile(file: File): Promise<string>
  detectFiles(paths: string[]): Promise<DetectedFile[]>
  /** Local preview URL (file://) for a media file, or null when none can be produced. */
  getFileThumbnail(path: string): Promise<string | null>
  convertFiles(request: ConversionRequest): Promise<{ ok: boolean; error?: string; added?: number; unavailable?: number }>
  getConverterJobs(): Promise<ConverterJob[]>
  cancelConversion(id: string): Promise<void>
  retryConversion(id: string): Promise<void>
  clearFinishedConversions(): Promise<void>
  clearAllConversions(): Promise<void>
  onConverterJobs(cb: (jobs: ConverterJob[]) => void): () => void
  onConverterProgress(cb: (p: ConverterProgressPayload) => void): () => void
  onConverterDetectProgress(cb: (p: ConverterDetectProgress) => void): () => void
}

/** Result of reading the Windows system clipboard through the main process. */
export interface ClipboardReadResult {
  success: boolean
  /** Trimmed clipboard text ("" when empty or non-text). */
  text: string
  /** True when the clipboard holds nothing at all. */
  empty: boolean
  /** True when the clipboard holds content (e.g. an image) but no text. */
  hasNonText?: boolean
  error?: string
}

export interface ElectronApi {
  readClipboardText(): Promise<ClipboardReadResult>
  minimizeWindow(): Promise<{ success: boolean; error?: string }>
  toggleMaximizeWindow(): Promise<{ success: boolean; maximized: boolean; error?: string }>
  closeWindow(confirmed?: boolean): Promise<{ success: boolean; cancelled?: boolean; error?: string }>
  isWindowMaximized(): Promise<{ success: boolean; maximized: boolean; error?: string }>
  onWindowStateChanged(cb: (state: { maximized: boolean }) => void): () => void
  clearCompletedDownloads(): Promise<{ success: boolean; removedIds: string[]; count: number; error?: string }>
  deleteAllHistory(): Promise<{ success: boolean; count: number; error?: string }>
  confirmDeleteAllHistory(): Promise<boolean>
  deleteAllCompleted(): Promise<{ success: boolean; count: number; error?: string }>
  confirmDeleteAllCompleted(): Promise<boolean>
  onHistoryCleared(cb: () => void): () => void
}

declare global {
  interface Window {
    vidaud: VidaudApi
    electronAPI: ElectronApi
  }
}
