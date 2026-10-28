import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { useI18n, interpolate } from '../i18n'
import { Button } from '../components/Button'
import { EmptyState, formatBytes, formatDate } from '../components/ui'
import { Icon } from '../components/Icon'
import type { CompletedItem } from '@shared/types'

type Filter = 'all' | 'video' | 'audio' | 'image'
type Sort = 'newest' | 'oldest' | 'nameAZ' | 'nameZA' | 'largest' | 'smallest'

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function sortItems(items: CompletedItem[], sort: Sort): CompletedItem[] {
  const arr = [...items]
  switch (sort) {
    case 'newest':
      arr.sort((a, b) => b.completedAt - a.completedAt)
      break
    case 'oldest':
      arr.sort((a, b) => a.completedAt - b.completedAt)
      break
    case 'nameAZ':
      arr.sort((a, b) => a.title.localeCompare(b.title))
      break
    case 'nameZA':
      arr.sort((a, b) => b.title.localeCompare(a.title))
      break
    case 'largest':
      arr.sort((a, b) => b.size - a.size)
      break
    case 'smallest':
      arr.sort((a, b) => a.size - b.size)
      break
  }
  return arr
}

export function Completed(): JSX.Element {
  const { completed, setCompleted, refreshCompleted, toast, confirm } = useApp()
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('newest')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return completed.filter((c) => {
      if (filter !== 'all' && c.type !== filter) return false
      if (q && !c.title.toLowerCase().includes(q) && !c.filePath.toLowerCase().includes(q)) return false
      return true
    })
  }, [completed, search, filter])

  const groups = useMemo(() => {
    const sorted = sortItems(filtered, sort)
    const map = new Map<string, CompletedItem[]>()
    const singles: CompletedItem[] = []
    for (const c of sorted) {
      if (c.playlistId) {
        const list = map.get(c.playlistId) ?? []
        list.push(c)
        map.set(c.playlistId, list)
      } else {
        singles.push(c)
      }
    }
    return { playlists: [...map.entries()], singles }
  }, [filtered, sort])

  const removeOne = async (id: string): Promise<void> => {
    const ok = await confirm({
      title: t('confirm.removeCompleted'),
      message: t('confirm.removeCompletedMessage')
    })
    if (!ok) return
    try {
      const res = await window.vidaud.removeCompleted(id)
      if (res && res.success) {
        setCompleted((items) => items.filter((i) => i.id !== id))
      } else {
        toast('error', t('completed.removeFailed'))
      }
    } catch {
      toast('error', t('completed.removeFailed'))
    }
  }

  const deleteFile = async (id: string): Promise<void> => {
    try {
      const res = await window.vidaud.deleteCompletedFile(id)
      if (res && res.success) {
        setCompleted((items) => items.filter((i) => i.id !== id))
        toast('info', t('completed.deleteFile'))
      } else {
        toast('error', t('completed.deleteFailed'))
      }
    } catch {
      toast('error', t('completed.deleteFailed'))
    }
  }

  const removeMissing = async (): Promise<void> => {
    try {
      const res = await window.vidaud.removeMissingCompleted()
      if (res && res.success) {
        setCompleted((items) => items.filter((i) => i.exists !== false))
        if (res.count > 0) toast('info', interpolate(t('completed.removeMissingDone'), { n: res.count }))
      } else {
        toast('error', t('completed.removeFailed'))
      }
    } catch {
      toast('error', t('completed.removeFailed'))
    }
  }

  const [isDeletingAll, setIsDeletingAll] = useState(false)

  const handleDeleteAll = async (): Promise<void> => {
    if (completed.length === 0 || isDeletingAll) return
    const ok = await confirm({
      title: t('confirm.deleteAllCompleted'),
      message: t('confirm.deleteAllCompletedMessage'),
      detail: t('confirm.filesNotDeleted'),
      danger: true
    })
    if (!ok) return

    setIsDeletingAll(true)
    try {
      const res = window.electronAPI?.deleteAllCompleted ? await window.electronAPI.deleteAllCompleted() : await window.vidaud.deleteAllCompleted()
      if (res && res.success) {
        setCompleted([])
        toast('info', t('completed.clearAllDone'))
      } else {
        toast('error', t('completed.clearAllFailed'))
      }
    } catch {
      toast('error', t('completed.clearAllFailed'))
    } finally {
      setIsDeletingAll(false)
    }
  }

  const handlePlay = async (c: CompletedItem): Promise<void> => {
    if (c.exists === false) {
      toast('error', t('completed.fileNotFound'))
      return
    }
    try {
      const res = await window.vidaud.openFile(c.filePath)
      if (res && res.success) {
        toast('info', t('completed.fileOpenedSuccess'))
      } else {
        const msg = res?.error === 'File not found' ? t('completed.fileNotFound') : t('completed.unableToOpen')
        toast('error', msg)
        await refreshCompleted()
      }
    } catch {
      toast('error', t('completed.unableToOpen'))
    }
  }

  const handleOpenFolder = async (c: CompletedItem): Promise<void> => {
    if (c.exists === false) {
      toast('error', t('completed.fileNotFound'))
      return
    }
    try {
      const res = await window.vidaud.openFolder(c.filePath)
      if (res && res.success) {
        toast('info', t('completed.folderOpenedSuccess'))
      } else {
        const msg = res?.error === 'File not found' ? t('completed.fileNotFound') : t('completed.unableToOpenFolder')
        toast('error', msg)
        await refreshCompleted()
      }
    } catch {
      toast('error', t('completed.unableToOpenFolder'))
    }
  }

  const handleLocateFile = async (c: CompletedItem): Promise<void> => {
    try {
      const res = await window.vidaud.locateFile(c.id)
      if (res && res.success) {
        toast('info', t('completed.fileLocated'))
        await refreshCompleted()
      }
    } catch {
      toast('error', t('completed.removeFailed'))
    }
  }

  const renderCard = (c: CompletedItem): JSX.Element => {
    const missing = c.exists === false
    return (
      <div key={c.id} className={`completed-card ${missing ? 'missing' : ''}`}>
        <div className="completed-card-thumb">
          {c.thumbnail ? <div className="thumb" style={{ backgroundImage: `url(${c.thumbnail})` }} /> : <div className="thumb" />}
          <span className="badge">
            <Icon name={c.type === 'video' ? 'video' : c.type === 'image' ? 'eye' : 'music'} size={11} />
            {c.type === 'video' ? t('completed.filterVideo') : c.type === 'image' ? t('converter.image') : t('completed.filterAudio')}
          </span>
        </div>
        <div className="completed-card-body">
          <div className="completed-card-title" title={c.title}>
            {c.title}
          </div>
          <div className="completed-card-meta">
            {c.quality ? <span>{t('completed.quality')}: {c.quality}</span> : null}
            {c.format ? <span>{t('completed.format')}: {String(c.format).toUpperCase()}</span> : null}
            {c.source === 'converter' && c.originalFormat ? (
              <span className="badge accent">
                {t('converter.convertFrom')}: {String(c.originalFormat).toUpperCase()}
              </span>
            ) : null}
            <span>{formatBytes(c.size)}</span>
            <span>{formatDate(c.completedAt)}</span>
          </div>
          <div className="completed-card-path" title={c.filePath}>
            {c.filePath}
          </div>
          {missing ? <div className="badge danger">{t('completed.missing')}</div> : null}
        </div>
        <div className="completed-card-actions">
          <Button size="sm" icon="play" disabled={missing} onClick={() => void handlePlay(c)}>
            {t('completed.play')}
          </Button>
          <Button size="sm" icon="openFolder" disabled={missing} onClick={() => void handleOpenFolder(c)}>
            {t('completed.openFolder')}
          </Button>
          {missing ? (
            <Button size="sm" variant="secondary" icon="analyze" onClick={() => void handleLocateFile(c)}>
              {t('completed.locateFile')}
            </Button>
          ) : null}
          <Button size="sm" variant="danger" icon="remove" title={t('completed.remove')} onClick={() => void removeOne(c.id)}>
            {t('completed.remove')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon="remove"
            title={t('completed.deleteFile')}
            disabled={missing}
            onClick={async () => {
              const ok = await confirm({
                title: t('confirm.deleteFile'),
                message: t('confirm.deleteFileMessage'),
                detail: `${fileNameOf(c.filePath)}\n\n${t('confirm.deleteFileDetail')}`,
                danger: true
              })
              if (ok) await deleteFile(c.id)
            }}
          >
            {t('completed.deleteFile')}
          </Button>
        </div>
      </div>
    )
  }

  const missingCount = completed.filter((c) => c.exists === false).length

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220, position: 'relative' }}>
          <input className="input" placeholder={t('completed.search')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingInlineStart: 36 }} />
          <Icon name="analyze" size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }} />
        </div>
        <Button size="sm" variant={filter === 'all' ? 'primary' : 'secondary'} onClick={() => setFilter('all')}>
          {t('completed.filter')}
        </Button>
        <Button size="sm" variant={filter === 'video' ? 'primary' : 'secondary'} onClick={() => setFilter('video')}>
          {t('completed.filterVideo')}
        </Button>
        <Button size="sm" variant={filter === 'audio' ? 'primary' : 'secondary'} onClick={() => setFilter('audio')}>
          {t('completed.filterAudio')}
        </Button>
        <Button size="sm" variant={filter === 'image' ? 'primary' : 'secondary'} onClick={() => setFilter('image')}>
          {t('converter.image')}
        </Button>
        <select className="input" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t('completed.sort')}>
          <option value="newest">{t('completed.sortNewest')}</option>
          <option value="oldest">{t('completed.sortOldest')}</option>
          <option value="nameAZ">{t('completed.sortNameAZ')}</option>
          <option value="nameZA">{t('completed.sortNameZA')}</option>
          <option value="largest">{t('completed.sortLargest')}</option>
          <option value="smallest">{t('completed.sortSmallest')}</option>
        </select>
        {missingCount > 0 ? (
          <Button size="sm" variant="secondary" icon="remove" onClick={() => void removeMissing()}>
            {t('completed.removeMissing')} ({missingCount})
          </Button>
        ) : null}
        {completed.length > 0 ? (
          <Button size="sm" variant="danger" icon="remove" disabled={isDeletingAll} onClick={() => void handleDeleteAll()}>
            {isDeletingAll ? t('history.deletingAll') : t('history.deleteAll')}
          </Button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="completed" text={search.trim() ? t('completed.noSearch') : t('completed.empty')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {groups.playlists.map(([playlistId, items]) => (
            <div key={playlistId}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Icon name="list" size={15} />
                <span style={{ fontWeight: 600 }}>{items[0]?.playlistTitle || t('completed.playlist')}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>{items.map(renderCard)}</div>
            </div>
          ))}
          {groups.singles.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>{groups.singles.map(renderCard)}</div>
          ) : null}
        </div>
      )}
    </div>
  )
}
