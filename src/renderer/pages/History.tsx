import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { useI18n } from '../i18n'
import { Button } from '../components/Button'
import { EmptyState, formatBytes, formatDate } from '../components/ui'
import { Icon } from '../components/Icon'

type Filter = 'all' | 'video' | 'audio' | 'image'

const STATUS_LABEL: Record<string, string> = {
  queued: 'task.waiting',
  analyzing: 'task.analyzing',
  downloading: 'task.downloading',
  processing: 'task.processing',
  converting: 'task.converting',
  retrying: 'task.retrying',
  completed: 'task.completed',
  failed: 'task.failed',
  cancelled: 'task.cancelled',
  unavailable: 'task.unavailable'
}

const STATUS_TONE: Record<string, string> = {
  queued: 'accent',
  analyzing: 'accent',
  downloading: 'accent',
  processing: 'accent',
  converting: 'accent',
  retrying: 'accent',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
  unavailable: 'warning'
}

export function History(): JSX.Element {
  const { history, setHistory, toast, confirm } = useApp()
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  // The AppContext reloads History from persistent storage every time this
  // page is entered. This component never seeds UI state from memory.

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return history.filter((h) => {
      if (filter !== 'all' && h.type !== filter) return false
      if (q && !h.fileName.toLowerCase().includes(q) && !h.path.toLowerCase().includes(q)) return false
      return true
    })
  }, [history, search, filter])

  const [isDeletingAll, setIsDeletingAll] = useState(false)

  const handleDeleteAllHistory = async (): Promise<void> => {
    if (history.length === 0 || isDeletingAll) return
    const ok = await confirm({
      title: t('confirm.deleteHistory'),
      message: t('confirm.deleteHistoryMessage'),
      detail: t('confirm.filesNotDeleted'),
      danger: true
    })
    if (!ok) return

    setIsDeletingAll(true)
    try {
      const res = window.electronAPI?.deleteAllHistory
        ? await window.electronAPI.deleteAllHistory()
        : await window.vidaud.deleteAllHistory()

      if (res && res.success) {
        setHistory([])
        console.log('[VIDAUD][HISTORY] UI items: 0 (after delete all)')
        toast('info', t('history.cleared'))
      } else {
        toast('error', t('history.clearFailed'))
      }
    } catch {
      toast('error', t('history.clearFailed'))
    } finally {
      setIsDeletingAll(false)
    }
  }

  const removeOne = async (id: string): Promise<void> => {
    try {
      const res = await window.vidaud.deleteHistoryItem(id)
      if (res && res.success) {
        setHistory((items) => items.filter((i) => i.id !== id))
      } else {
        toast('error', t('history.deleteFailed'))
      }
    } catch {
      toast('error', t('history.deleteFailed'))
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220, position: 'relative' }}>
          <input className="input" placeholder={t('history.search')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingInlineStart: 36 }} />
          <Icon name="analyze" size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }} />
        </div>
        <Button size="sm" variant={filter === 'all' ? 'primary' : 'secondary'} onClick={() => setFilter('all')}>
          {t('history.filter')}
        </Button>
        <Button size="sm" variant={filter === 'video' ? 'primary' : 'secondary'} onClick={() => setFilter('video')}>
          {t('history.filterVideo')}
        </Button>
        <Button size="sm" variant={filter === 'audio' ? 'primary' : 'secondary'} onClick={() => setFilter('audio')}>
          {t('history.filterAudio')}
        </Button>
        <Button size="sm" variant={filter === 'image' ? 'primary' : 'secondary'} onClick={() => setFilter('image')}>
          {t('converter.image')}
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="remove"
          disabled={history.length === 0 || isDeletingAll}
          onClick={() => void handleDeleteAllHistory()}
          style={{ minHeight: 34, fontSize: 13.5, borderRadius: 8 }}
        >
          {isDeletingAll ? t('history.deletingAll') : t('history.deleteAll')}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="history" text={t('history.empty')} />
      ) : (
        <div style={{ background: 'var(--glass)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)', overflow: 'hidden', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('history.file')}</th>
                <th>{t('history.date')}</th>
                <th>{t('history.type')}</th>
                <th>{t('history.size')}</th>
                <th>{t('history.status')}</th>
                <th>{t('history.path')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((h) => (
                <tr key={h.id} style={{ cursor: h.path ? 'pointer' : 'default' }} onClick={() => h.path && void window.vidaud.openPath(h.path)}>
                  <td style={{ color: 'var(--text)', fontWeight: 500 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{h.fileName}</span>
                      {h.playlistIndex && h.playlistCount ? (
                        <span className="badge" style={{ flex: '0 0 auto' }}>
                          {h.playlistIndex} / {h.playlistCount}
                        </span>
                      ) : null}
                    </div>
                    {h.playlistTitle ? <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>{h.playlistTitle}</div> : null}
                  </td>
                  <td>{formatDate(h.date)}</td>
                  <td>
                    <span className="badge">
                      <Icon name={h.type === 'video' ? 'video' : h.type === 'image' ? 'eye' : 'music'} size={11} />
                      {h.type === 'video' ? t('history.filterVideo') : h.type === 'image' ? t('converter.image') : t('history.filterAudio')}
                      {h.source === 'converter' ? ` · ${t('converter.title')}` : ''}
                    </span>
                  </td>
                  <td>{formatBytes(h.size)}</td>
                  <td>
                    <span className={`badge ${STATUS_TONE[h.status] ?? 'accent'}`}>{t(STATUS_LABEL[h.status] ?? 'task.failed')}</span>
                  </td>
                  <td style={{ maxWidth: 200 }} title={h.path}>
                    {h.path || '—'}
                  </td>
                  <td>
                    <button
                      className="icon-btn"
                      style={{ color: 'var(--text-faint)' }}
                      title={t('history.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        removeOne(h.id)
                      }}
                    >
                      <Icon name="remove" size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
