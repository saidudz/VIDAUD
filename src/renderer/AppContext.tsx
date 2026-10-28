import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppSettings, CompletedItem, ConverterJob, DownloadProgressPayload, DownloadTask, HistoryEntry, NotificationPayload, PlaylistJob, StatsSummary } from '@shared/types'
import type { ConfirmDialogOptions } from './components/ConfirmDialog'
import { I18nProvider, useI18n, type Lang } from './i18n'

export type Page = 'dashboard' | 'downloads' | 'completed' | 'history' | 'converter' | 'settings'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  title: string
  body?: string
}

interface AppContextValue {
  page: Page
  setPage: (p: Page) => void
  tasks: DownloadTask[]
  stats: StatsSummary
  playlists: PlaylistJob[]
  history: HistoryEntry[]
  setHistory: React.Dispatch<React.SetStateAction<HistoryEntry[]>>
  refreshHistory: () => Promise<HistoryEntry[]>
  completed: CompletedItem[]
  setCompleted: React.Dispatch<React.SetStateAction<CompletedItem[]>>
  refreshCompleted: () => Promise<CompletedItem[]>
  converterJobs: ConverterJob[]
  setConverterJobs: React.Dispatch<React.SetStateAction<ConverterJob[]>>
  refreshConverterJobs: () => Promise<ConverterJob[]>
  settings: AppSettings | null
  updateSettings: (patch: Partial<AppSettings>) => void
  saveSettings: (patch?: Partial<AppSettings>) => Promise<AppSettings | null>
  toasts: Toast[]
  toast: (kind: Toast['kind'], title: string, body?: string) => void
  dismissToast: (id: number) => void
  refresh: () => void
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>
  confirmState: ConfirmDialogOptions | null
  resolveConfirm: (value: boolean) => void
}

const AppContext = createContext<AppContextValue | null>(null)

const emptyStats: StatsSummary = { active: 0, completed: 0, failed: 0, totalBytes: 0 }

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [page, setPage] = useState<Page>('dashboard')
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [stats, setStats] = useState<StatsSummary>(emptyStats)
  const [playlists, setPlaylists] = useState<PlaylistJob[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [completed, setCompleted] = useState<CompletedItem[]>([])
  const [converterJobs, setConverterJobs] = useState<ConverterJob[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  const historyReqId = useRef(0)
  const completedReqId = useRef(0)

  const [confirmState, setConfirmState] = useState<ConfirmDialogOptions | null>(null)
  const confirmResolver = useRef<((value: boolean) => void) | null>(null)

  const { setLang } = useI18n()

  const confirm = useCallback((options: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      confirmResolver.current?.(false)
      confirmResolver.current = resolve
      setConfirmState(options)
    })
  }, [])

  const resolveConfirm = useCallback((value: boolean) => {
    confirmResolver.current?.(value)
    confirmResolver.current = null
    setConfirmState(null)
  }, [])

  const toast = useCallback((kind: Toast['kind'], title: string, body?: string) => {
    const id = ++toastId.current
    setToasts((prev) => [...prev, { id, kind, title, body }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4200)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  useEffect(() => {
    const loadReqId = ++historyReqId.current
    void (async () => {
      try {
        // Settings first: the shell renders as soon as this single fast call
        // resolves, so first paint is not blocked by the potentially large
        // (history/queue/completed) payloads that follow.
        const s = await window.vidaud.getSettings()
        if (loadReqId !== historyReqId.current) return
        setSettings(s)
        const [q, st, h, p, c, cj] = await Promise.all([
          window.vidaud.getQueue(),
          window.vidaud.getStats(),
          window.vidaud.getHistory(),
          window.vidaud.getPlaylists(),
          window.vidaud.getCompleted(),
          window.vidaud.getConverterJobs()
        ])
        if (loadReqId !== historyReqId.current) return
        setTasks(q)
        setStats(st)
        setHistory(h)
        setPlaylists(p)
        setCompleted(c)
        setConverterJobs(cj)
      } catch (e) {
        console.error('initial load failed', e)
      }
    })()
  }, [])

  // apply language + theme
  useEffect(() => {
    if (settings) {
      setLang(settings.language as Lang)
      document.documentElement.dir = settings.language === 'ar' ? 'rtl' : 'ltr'
      document.documentElement.lang = settings.language
    }
  }, [settings, setLang])

  useEffect(() => {
    const theme = settings?.theme ?? 'dark'
    if (theme === 'system') {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    } else {
      document.documentElement.dataset.theme = theme
    }
  }, [settings?.theme])

  // live events
  useEffect(() => {
    const offQueue = window.vidaud.onQueue(setTasks)
    const offStats = window.vidaud.onStats(setStats)
    const offStatistics = window.vidaud.onStatistics(setStats)
    const offHistory = window.vidaud.onHistory(setHistory)
    const offPlaylists = window.vidaud.onPlaylists(setPlaylists)
    const offCompleted = window.vidaud.onCompleted(setCompleted)
    const offConverterJobs = window.vidaud.onConverterJobs(setConverterJobs)
    const offCleared = window.vidaud.onHistoryCleared(() => {
      historyReqId.current += 1
      setHistory([])
    })
    const offClearedDownloads = window.vidaud.onDownloadsClearedCompleted((removedIds: string[]) => {
      if (!removedIds || removedIds.length === 0) return
      // removedIds contains task ids plus composite keys `playlist:<pid>:<itemId>`
      // for completed playlist items removed from the Downloads list.
      const taskIds = new Set<string>()
      const itemKeys = new Set<string>()
      for (const id of removedIds) {
        if (id.startsWith('playlist:')) {
          const rest = id.slice('playlist:'.length)
          const sep = rest.indexOf(':')
          if (sep > 0) itemKeys.add(`${rest.slice(0, sep)}::${rest.slice(sep + 1)}`)
        } else {
          taskIds.add(id)
        }
      }
      setTasks((prev) => prev.filter((t) => !taskIds.has(t.id)))
      setPlaylists((prev) =>
        prev
          .map((j) => ({ ...j, items: j.items.filter((i) => !itemKeys.has(`${j.playlistId}::${i.itemId}`)) }))
          .filter((j) => j.items.length > 0)
      )
    })
    return () => {
      offQueue()
      offStats()
      offStatistics()
      offHistory()
      offPlaylists()
      offCompleted()
      offConverterJobs()
      offCleared()
      offClearedDownloads()
    }
  }, [])

  // high-frequency per-task progress: merge into the tasks state without
  // replacing the authoritative queue snapshot fields (state/format/errors...)
  useEffect(() => {
    const offProgress = window.vidaud.onDownloadProgress((p: DownloadProgressPayload) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === p.id)
        if (idx < 0) return prev
        const task = prev[idx]
        const updated: DownloadTask = {
          ...task,
          updatedAt: Date.now(),
          progress: {
            ...task.progress,
            percent: p.percent ?? task.progress.percent,
            indeterminate: p.percent === null,
            speedBytes: p.speed,
            downloadedBytes: p.downloadedBytes,
            totalBytes: p.totalBytes ?? task.progress.totalBytes,
            etaSeconds: p.eta ?? task.progress.etaSeconds,
            phase: p.phase
          }
        }
        if (idx === prev.length - 1) {
          const next = prev.slice()
          next[idx] = updated
          return next
        }
        return prev.map((t, i) => (i === idx ? updated : t))
      })
    })
    return () => offProgress()
  }, [])

  // high-frequency converter progress: merge percent/stage into jobs state
  useEffect(() => {
    const offProgress = window.vidaud.onConverterProgress((p: { id: string; percent: number | null; stage: string }) => {
      setConverterJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === p.id)
        if (idx < 0) return prev
        const job = prev[idx]
        const updated: ConverterJob = {
          ...job,
          updatedAt: Date.now(),
          progress: {
            ...job.progress,
            percent: p.percent ?? job.progress.percent,
            indeterminate: p.percent === null,
            stage: p.stage,
            message: p.stage
          }
        }
        return prev.map((j, i) => (i === idx ? updated : j))
      })
    })
    return () => offProgress()
  }, [])

  // desktop notifications -> in-app toasts
  useEffect(() => {
    const offNotify = window.vidaud.onNotify((p: NotificationPayload) => {
      toast(p.title.includes('failed') ? 'error' : 'success', p.title, p.body)
    })
    const offClick = (): void => {
      setPage('downloads')
    }
    window.addEventListener('vidaud:notification:click' as never, offClick as never)
    return () => {
      offNotify()
      window.removeEventListener('vidaud:notification:click' as never, offClick as never)
    }
  }, [toast])

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const saveSettings = useCallback(async (patch?: Partial<AppSettings>) => {
    if (!settings) return null
    const merged: AppSettings = patch ? { ...settings, ...patch } : settings
    const saved = await window.vidaud.saveSettings(merged)
    setSettings(saved)
    return saved
  }, [settings])

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const [q, st] = await Promise.all([window.vidaud.getQueue(), window.vidaud.getStats()])
        setTasks(q)
        setStats(st)
      } catch {
        /* ignore */
      }
    })()
  }, [])

  // Always pull the latest History from persistent storage. Uses a request id
  // so a stale in-flight response can never overwrite a newer one (race guard).
  const refreshHistory = useCallback(async (): Promise<HistoryEntry[]> => {
    const reqId = ++historyReqId.current
    try {
      const items = await window.vidaud.getHistory()
      if (reqId !== historyReqId.current) return []
      setHistory(items)
      console.log('[VIDAUD][HISTORY] UI items:', items.length)
      return items
    } catch (e) {
      console.error('[VIDAUD][HISTORY] load failed', e)
      return []
    }
  }, [])

  // Entering the History page must always re-read persistent storage and
  // replace the React state wholesale — never reuse stale/memory-cached state.
  useEffect(() => {
    if (page !== 'history') return
    console.log('[VIDAUD][HISTORY] Loading...')
    void refreshHistory()
  }, [page, refreshHistory])

  const refreshCompleted = useCallback(async (): Promise<CompletedItem[]> => {
    const reqId = ++completedReqId.current
    try {
      const items = await window.vidaud.getCompleted()
      if (reqId !== completedReqId.current) return []
      setCompleted(items)
      return items
    } catch (e) {
      console.error('[VIDAUD][COMPLETED] load failed', e)
      return []
    }
  }, [])

  useEffect(() => {
    if (page !== 'completed') return
    void refreshCompleted()
  }, [page, refreshCompleted])

  const refreshConverterJobs = useCallback(async (): Promise<ConverterJob[]> => {
    try {
      const jobs = await window.vidaud.getConverterJobs()
      setConverterJobs(jobs)
      return jobs
    } catch (e) {
      console.error('[VIDAUD][CONVERTER] load failed', e)
      return []
    }
  }, [])

  useEffect(() => {
    if (page !== 'converter') return
    void refreshConverterJobs()
  }, [page, refreshConverterJobs])

  const value = useMemo(
    () => ({ page, setPage, tasks, stats, playlists, history, setHistory, refreshHistory, completed, setCompleted, refreshCompleted, converterJobs, setConverterJobs, refreshConverterJobs, settings, updateSettings, saveSettings, toasts, toast, dismissToast, refresh, confirm, confirmState, resolveConfirm }),
    [page, tasks, stats, playlists, history, setHistory, refreshHistory, completed, setCompleted, refreshCompleted, converterJobs, setConverterJobs, refreshConverterJobs, settings, updateSettings, saveSettings, toasts, toast, dismissToast, refresh, confirm, confirmState, resolveConfirm]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
