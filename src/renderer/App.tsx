import { AppProvider, useApp } from './AppContext'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { Downloads } from './pages/Downloads'
import { Completed } from './pages/Completed'
import { History } from './pages/History'
import { Converter } from './pages/Converter'
import { Settings } from './pages/Settings'
import { Icon } from './components/Icon'
import { ConfirmDialogHost } from './components/ConfirmDialog'
import { useEffect, useState } from 'react'

function ToastContainer(): JSX.Element | null {
  const { toasts, dismissToast } = useApp()
  if (toasts.length === 0) return null
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'success' ? 'checkCircle' : t.kind === 'error' ? 'warnCircle' : 'info'} size={18} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.title}</div>
            {t.body ? (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.body}</div>
            ) : null}
          </div>
          <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="dismiss">
            <Icon name="clear" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

function PageView(): JSX.Element {
  const { page } = useApp()
  switch (page) {
    case 'downloads':
      return <Downloads />
    case 'completed':
      return <Completed />
    case 'history':
      return <History />
    case 'converter':
      return <Converter />
    case 'settings':
      return <Settings />
    default:
      return <Dashboard />
  }
}

function Shell(): JSX.Element {
  const [ready, setReady] = useState(false)
  const { settings } = useApp()

  useEffect(() => {
    if (settings) setReady(true)
  }, [settings])

  if (!ready) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 3, marginBottom: 14, color: 'var(--text)' }}>VIDAUD</div>
          <span className="spinner" style={{ width: 26, height: 26 }} />
        </div>
      </div>
    )
  }

  return (
    <Layout>
      <PageView />
      <ToastContainer />
      <ConfirmDialogHost />
    </Layout>
  )
}

export default function App(): JSX.Element {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
