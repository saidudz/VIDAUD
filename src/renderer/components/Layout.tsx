import { useEffect, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { useApp, type Page } from '../AppContext'
import { Icon, type IconName } from './Icon'
import { useI18n } from '../i18n'

const navItems: Array<{ page: Page; labelKey: string; icon: IconName }> = [
  { page: 'dashboard', labelKey: 'nav.dashboard', icon: 'dashboard' },
  { page: 'downloads', labelKey: 'nav.downloads', icon: 'downloads' },
  { page: 'completed', labelKey: 'nav.completed', icon: 'completed' },
  { page: 'history', labelKey: 'nav.history', icon: 'history' },
  { page: 'converter', labelKey: 'nav.converter', icon: 'convert' },
  { page: 'settings', labelKey: 'nav.settings', icon: 'settings' }
]

const titles: Record<Page, string> = {
  dashboard: 'VIDAUD',
  downloads: 'downloads.title',
  completed: 'completed.title',
  history: 'history.title',
  converter: 'converter.title',
  settings: 'settings.title'
}

export function Layout({ children }: { children: ReactNode }): JSX.Element {
  const { page, setPage, tasks, confirm } = useApp()
  const { t } = useI18n()
  const [isMax, setIsMax] = useState(false)

  useEffect(() => {
    // Get initial state
    const checkMax = async (): Promise<void> => {
      try {
        if (window.electronAPI?.isWindowMaximized) {
          const res = await window.electronAPI.isWindowMaximized()
          if (res.success) setIsMax(res.maximized)
        } else if (window.vidaud?.windowIsMaximized) {
          const m = await window.vidaud.windowIsMaximized()
          setIsMax(m)
        }
      } catch {
        /* ignore */
      }
    }
    void checkMax()

    // Subscribe to window state events so the icon updates instantly
    const offState = window.electronAPI?.onWindowStateChanged?.((s) => setIsMax(s.maximized))
    const offMax = window.vidaud?.onWindowMaximized?.(() => setIsMax(true))
    const offUnmax = window.vidaud?.onWindowUnmaximized?.(() => setIsMax(false))

    return () => {
      offState?.()
      offMax?.()
      offUnmax?.()
    }
  }, [])

  const handleMinimize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (window.electronAPI?.minimizeWindow) {
      void window.electronAPI.minimizeWindow()
    } else if (window.vidaud?.windowMinimize) {
      void window.vidaud.windowMinimize()
    }
  }

  const handleMaximize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (window.electronAPI?.toggleMaximizeWindow) {
      void window.electronAPI.toggleMaximizeWindow()
    } else if (window.vidaud?.windowMaximize) {
      void window.vidaud.windowMaximize()
    }
  }

  const handleClose = async (e?: ReactMouseEvent): Promise<void> => {
    e?.preventDefault()
    e?.stopPropagation()
    const active = tasks.some(
      (x) => x.state === 'Downloading' || x.state === 'Processing' || x.state === 'Converting' || x.state === 'Waiting' || x.state === 'Analyzing' || x.state === 'Retrying'
    )
    if (active) {
      const ok = await confirm({
        title: t('confirm.close'),
        message: t('confirm.closeMessage'),
        danger: true
      })
      if (!ok) return
    }
    if (window.electronAPI?.closeWindow) {
      void window.electronAPI.closeWindow(active)
    } else if (window.vidaud?.windowClose) {
      void window.vidaud.windowClose(active)
    }
  }

  const go = (p: Page): void => {
    console.log('[VIDAUD][NAV]', p, 'clicked')
    setPage(p)
    console.log('[VIDAUD][NAV] currentPage =', p)
  }

  return (
    <div className="app">
      <div className="app-overlay" aria-hidden="true" />
      <aside className="sidebar">
        {navItems.map((item) => (
          <button key={item.page} className={`nav-item ${page === item.page ? 'active' : ''}`} onClick={() => go(item.page)}>
            <Icon name={item.icon} size={19} />
            {t(item.labelKey)}
          </button>
        ))}
        <div className="sidebar-footer">Video &amp; Audio Downloader</div>
      </aside>
      <main className="main">
        <header className="topbar">
          <h1>{page === 'dashboard' ? 'VIDAUD' : t(titles[page])}</h1>
          <div className="window-controls">
            <button
              type="button"
              className="window-control-btn"
              onClick={handleMinimize}
              title="Minimize"
              aria-label="Minimize Window"
            >
              <Icon name="winMinimize" size={14} />
            </button>
            <button
              type="button"
              className="window-control-btn"
              onClick={handleMaximize}
              title={isMax ? 'Restore' : 'Maximize'}
              aria-label={isMax ? 'Restore Window' : 'Maximize Window'}
            >
              <Icon name={isMax ? 'winRestore' : 'winMaximize'} size={14} />
            </button>
            <button
              type="button"
              className="window-control-btn close"
              onClick={() => void handleClose()}
              title="Close"
              aria-label="Close Application"
            >
              <Icon name="winClose" size={14} />
            </button>
          </div>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  )
}
