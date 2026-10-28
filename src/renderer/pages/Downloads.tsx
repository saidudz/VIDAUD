import { memo, useMemo, useState } from 'react'
import type { DownloadTask, PlaylistJob, PlaylistItem, PlaylistStats } from '@shared/types'
import { useApp } from '../AppContext'
import { useI18n } from '../i18n'
import { Button } from '../components/Button'
import { EmptyState, ProgressBar, formatBytes, formatSpeed, formatEta } from '../components/ui'
import { Icon, type IconName } from '../components/Icon'

/** Client-side guard mirroring the backend rules: an item with no real title
 *  ("Untitled", "Unknown", "Item 21", empty) is never rendered, even if an old
 *  record slips through. Excluded items are not jobs, so they also carry no
 *  Retry/Pause/Cancel actions. */
function hasRealTitle(title: unknown): boolean {
  const raw = typeof title === 'string' ? title.trim() : ''
  if (!raw) return false
  const t = raw.replace(/^\d+\s*[-–—.\s]\s*/, '').trim().toLowerCase()
  return t.length > 0 && t !== 'untitled' && t !== 'unknown' && !/^item\s*\d+$/.test(t)
}

const stateInfo: Record<string, { key: string; icon: IconName; tone: string }> = {
  Waiting: { key: 'task.waiting', icon: 'clock', tone: 'waiting' },
  Analyzing: { key: 'task.analyzing', icon: 'analyze', tone: 'waiting' },
  Downloading: { key: 'task.downloading', icon: 'download', tone: 'downloading' },
  Processing: { key: 'task.processing', icon: 'settings', tone: 'processing' },
  Converting: { key: 'task.converting', icon: 'retry', tone: 'processing' },
  Completed: { key: 'task.completed', icon: 'checkCircle', tone: 'completed' },
  Retrying: { key: 'task.retrying', icon: 'retry', tone: 'processing' },
  Failed: { key: 'task.failed', icon: 'warnCircle', tone: 'failed' },
  Unavailable: { key: 'task.unavailable', icon: 'warnCircle', tone: 'failed' },
  Cancelled: { key: 'task.cancelled', icon: 'cancel', tone: 'cancelled' },
  Paused: { key: 'task.paused', icon: 'pause', tone: 'paused' }
}

/** Compares only the render-relevant fields so high-frequency progress updates
 *  on one task never re-render sibling tasks (memoized rows below). */
function taskChanged(a: DownloadTask, b: DownloadTask): boolean {
  return !(
    a.state === b.state &&
    a.title === b.title &&
    a.thumbnail === b.thumbnail &&
    a.filePath === b.filePath &&
    a.error === b.error &&
    a.errorDetails === b.errorDetails &&
    a.playlistId === b.playlistId &&
    a.playlistIndex === b.playlistIndex &&
    a.playlistCount === b.playlistCount &&
    a.kind === b.kind &&
    a.format === b.format &&
    a.quality === b.quality &&
    a.progress?.percent === b.progress?.percent &&
    a.progress?.indeterminate === b.progress?.indeterminate &&
    a.progress?.speedBytes === b.progress?.speedBytes &&
    a.progress?.downloadedBytes === b.progress?.downloadedBytes &&
    a.progress?.totalBytes === b.progress?.totalBytes &&
    a.progress?.etaSeconds === b.progress?.etaSeconds &&
    a.progress?.stage === b.progress?.stage &&
    a.progress?.phase === b.progress?.phase &&
    a.progress?.message === b.progress?.message
  )
}

/**
 * Per-file action buttons for a download card. Every destructive action goes
 * through the real engine over IPC (window.vidaud.pause/resume/cancel/retry).
 * Pause/Resume are non-destructive and fire immediately; Cancel is destructive
 * and therefore gated behind the shared ConfirmDialog (Yes/No) — the IPC
 * request is only sent after the user confirms with Yes.
 */
function DownloadJobCardControls({ task }: { task: DownloadTask }): JSX.Element {
  const { t } = useI18n()
  const { confirm } = useApp()
  const [isCancelling, setIsCancelling] = useState(false)

  const canPause = task.state === 'Downloading' || task.state === 'Waiting' || task.state === 'Analyzing'
  const canResume = task.state === 'Paused' || (task.state === 'Waiting' && !task.progress?.downloadedBytes)
  const canCancel = task.state === 'Downloading' || task.state === 'Processing' || task.state === 'Converting' || task.state === 'Analyzing' || task.state === 'Retrying' || task.state === 'Waiting' || task.state === 'Paused'
  const canRetry = task.state === 'Failed' || task.state === 'Cancelled'
  const canRemove = !['Downloading', 'Processing', 'Converting', 'Analyzing', 'Retrying'].includes(task.state)
  const canOpen = task.state === 'Completed' || task.state === 'Failed' || task.state === 'Cancelled'

  const handleCancel = async (): Promise<void> => {
    if (isCancelling) return
    const ok = await confirm({
      title: t('confirm.cancelDownload'),
      message: t('confirm.cancelDownloadMessage'),
      danger: true
    })
    if (!ok) return
    setIsCancelling(true)
    try {
      await window.vidaud.cancel(task.id)
    } finally {
      setIsCancelling(false)
    }
  }

  return (
    <div className="task-actions">
      {canPause ? (
        <Button size="sm" icon="pause" onClick={() => void window.vidaud.pause(task.id)} title={t('task.pause')}>
          {t('task.pause')}
        </Button>
      ) : null}
      {canResume ? (
        <Button size="sm" variant="primary" icon="resume" onClick={() => void window.vidaud.resume(task.id)} title={t('task.resume')}>
          {t('task.resume')}
        </Button>
      ) : null}
      {canCancel ? (
        <Button size="sm" variant="danger" icon="cancel" disabled={isCancelling} onClick={() => void handleCancel()} title={t('task.cancel')}>
          {isCancelling ? t('downloads.cancelling') : t('task.cancel')}
        </Button>
      ) : null}
      {canRetry ? (
        <Button size="sm" variant="primary" icon="retry" onClick={() => void window.vidaud.retry(task.id)}>
          {t('task.retry')}
        </Button>
      ) : null}
      {canOpen ? (
        <button className="icon-btn" onClick={() => void window.vidaud.openPath(task.filePath ?? '')} disabled={!task.filePath} title={t('task.openFile')}>
          <Icon name="play" size={16} />
        </button>
      ) : null}
      {canOpen ? (
        <button className="icon-btn" onClick={() => void window.vidaud.openFolder(task.filePath ?? '')} title={t('task.openFolder')}>
          <Icon name="openFolder" size={16} />
        </button>
      ) : null}
      {canRemove ? (
        <button className="icon-btn" onClick={() => void window.vidaud.remove(task.id)} title={t('task.remove')}>
          <Icon name="remove" size={16} />
        </button>
      ) : null}
    </div>
  )
}

function TaskItem({ task }: { task: DownloadTask }): JSX.Element {
  const { t } = useI18n()
  const [showDetails, setShowDetails] = useState(false)
  const info = stateInfo[task.state] ?? stateInfo.Waiting
  const active = task.state === 'Downloading'
  const processing = task.state === 'Processing' || task.state === 'Converting' || task.state === 'Analyzing' || task.state === 'Retrying'
  const percent = task.progress?.percent ?? 0

  const subParts: string[] = []
  if (active || processing) {
    if (task.progress?.stage === 'retry' && task.progress.message) subParts.push(task.progress.message)
    else if (task.progress?.message && task.progress.stage !== 'download') subParts.push(task.progress.message)
  }
  if (active) {
    if (task.progress?.downloadedBytes) subParts.push(`${formatBytes(task.progress.downloadedBytes)} / ${formatBytes(task.progress.totalBytes)}`)
    if (task.progress?.speedBytes) subParts.push(`${formatSpeed(task.progress.speedBytes)}`)
    if (task.progress?.etaSeconds) subParts.push(`${formatEta(task.progress.etaSeconds)} ${t('downloads.eta')}`)
  }
  if (task.filePath) subParts.push(task.filePath)

  const formatLabel =
    task.kind === 'image'
      ? task.progress?.phase === 'validation' || task.state === 'Processing'
        ? `${task.format.toUpperCase()} · ${t('task.validating')}`
        : `${task.format.toUpperCase()} · Image`
      : task.kind === 'video'
        ? task.state === 'Completed'
          ? `${task.format.toUpperCase()} · ${t('task.audioVideo')}`
          : task.progress?.phase === 'merge' || task.progress?.stage === 'merging'
            ? `${task.format.toUpperCase()} · ${t('task.merging')}`
            : task.progress?.phase === 'validation'
              ? `${task.format.toUpperCase()} · ${t('task.validating')}`
              : task.progress?.phase === 'remux' || task.progress?.stage === 'remux'
                ? `${task.format.toUpperCase()} · ${t('task.remuxing')}`
                : `${task.format.toUpperCase()} · ${t('task.videoAudio')}`
        : task.progress?.phase === 'converting' || task.state === 'Converting'
          ? `${task.format.toUpperCase()} · ${t('task.converting')}`
          : `${task.format.toUpperCase()} · ${t(`quality.${task.quality}`)}`

  return (
    <div className="task-item">
      {task.thumbnail ? (
        <div className="task-thumb" style={{ backgroundImage: `url(${task.thumbnail})` }} />
      ) : (
        <div className="task-thumb">
          <Icon name={task.kind === 'video' ? 'video' : task.kind === 'image' ? 'eye' : 'music'} size={20} />
        </div>
      )}
      <div className="task-main">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`state-dot ${info.tone}`} />
          <span className="task-title" title={task.title}>
            {task.title}
          </span>
          {task.playlistId && task.playlistIndex && task.playlistCount ? (
            <span className="badge" style={{ flex: '0 0 auto' }}>
              {task.playlistIndex} / {task.playlistCount}
            </span>
          ) : null}
        </div>
        <div className="task-sub">
          <span className={`badge ${task.state === 'Completed' ? 'success' : task.state === 'Failed' ? 'danger' : task.state === 'Paused' || task.state === 'Cancelled' ? '' : 'accent'}`}>
            <Icon name={info.icon} size={11} />
            {t(info.key)}
          </span>
          <span className="badge">
            <Icon name={task.kind === 'video' ? 'video' : task.kind === 'image' ? 'eye' : 'music'} size={11} />
            {formatLabel}
          </span>
          {subParts.length > 0 ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subParts.join(' · ')}</span> : null}
        </div>
        {(active || processing || task.state === 'Paused') ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <ProgressBar
              percent={percent}
              indeterminate={task.progress?.indeterminate || (processing && task.progress?.percent == null) || task.state === 'Analyzing' || task.state === 'Retrying'}
              tone={task.state === 'Failed' ? 'danger' : task.state === 'Completed' ? 'success' : undefined}
            />
            <span style={{ fontSize: 12, color: 'var(--text-dim)', width: 40, textAlign: 'end' }}>
              {task.progress?.indeterminate || (processing && task.progress?.percent == null) ? '…' : `${Math.round(percent)}%`}
            </span>
          </div>
        ) : null}
        {task.state === 'Failed' ? task.error ? (
          <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--danger)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{task.error}</span>
              <button
                style={{ color: 'var(--text-dim)', fontSize: 12, textDecoration: 'underline' }}
                onClick={() => setShowDetails((v) => !v)}
              >
                {t('error.details')}
              </button>
            </div>
            {showDetails && task.errorDetails ? (
              <pre
                style={{
                  marginTop: 6,
                  padding: 10,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 11,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  color: 'var(--text-dim)',
                  maxHeight: 180,
                  overflow: 'auto'
                }}
              >
                {task.errorDetails}
              </pre>
            ) : null}
          </div>
        ) : null : null}
      </div>
      <DownloadJobCardControls task={task} />
    </div>
  )
}

const TaskItemMemo = memo(TaskItem, (prev, next) => !taskChanged(prev.task, next.task))

interface PlaylistGroup {
  key: string
  title: string
  tasks: DownloadTask[]
}

function computeStats(job: PlaylistJob): PlaylistStats {
  const s: PlaylistStats = { total: job.totalItems || job.items.length, queued: 0, analyzing: 0, downloading: 0, completed: 0, retrying: 0, failed: 0, unavailable: 0, cancelled: 0, finished: false }
  for (const item of job.items) {
      switch (item.status) {
        case 'Waiting':
        case 'Paused':
          s.queued += 1
          break
      case 'Analyzing':
        s.analyzing += 1
        break
      case 'Downloading':
      case 'Processing':
      case 'Converting':
        s.downloading += 1
        break
      case 'Completed':
        s.completed += 1
        break
      case 'Retrying':
        s.retrying += 1
        break
      case 'Failed':
        s.failed += 1
        break
      case 'Unavailable':
        s.unavailable += 1
        break
      case 'Cancelled':
        s.cancelled += 1
        break
    }
  }
  const terminal = s.completed + s.unavailable + s.cancelled
  s.finished = s.total > 0 && terminal === s.total && s.failed === 0
  return s
}

function itemChanged(a: PlaylistItem, b: PlaylistItem): boolean {
  return !(
    a.status === b.status &&
    a.title === b.title &&
    a.error === b.error &&
    a.errorDetails === b.errorDetails &&
    a.index === b.index
  )
}

function PlaylistItemRow({ job, item, displayIndex }: { job: PlaylistJob; item: PlaylistItem; displayIndex?: number }): JSX.Element {
  const { t } = useI18n()
  const [showDetails, setShowDetails] = useState(false)
  const info = stateInfo[item.status] ?? stateInfo.Waiting
  const canRetry = item.status === 'Failed' || item.status === 'Cancelled'
  const numbered = `${String(displayIndex ?? item.index).padStart(2, '0')}.`
  return (
    <div className="task-item" style={{ borderColor: item.status === 'Completed' ? 'var(--border)' : undefined }}>
      <div className="task-main">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="state-dot" style={{ background: `var(--tone-${info.tone === 'waiting' ? 'accent' : info.tone})` }} />
          <span className="task-title" style={{ flex: '0 0 auto', minWidth: 44 }} title={item.title}>
            {numbered}
          </span>
          <span className="task-title" title={item.title}>
            {item.title}
          </span>
        </div>
        <div className="task-sub">
          <span className={`badge ${item.status === 'Completed' ? 'success' : item.status === 'Failed' ? 'danger' : item.status === 'Cancelled' ? '' : 'accent'}`}>
            <Icon name={info.icon} size={11} />
            {t(info.key)}
          </span>
          {item.error ? (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--danger)' }}>{item.error}</span>
          ) : null}
        </div>
        {item.status === 'Failed' && item.error ? (
          <div style={{ marginTop: 6 }}>
            <button style={{ color: 'var(--text-dim)', fontSize: 12, textDecoration: 'underline' }} onClick={() => setShowDetails((v) => !v)}>
              {t('error.details')}
            </button>
            {showDetails && item.errorDetails ? (
              <pre
                style={{
                  marginTop: 6,
                  padding: 10,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 11,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  color: 'var(--text-dim)',
                  maxHeight: 180,
                  overflow: 'auto'
                }}
              >
                {item.errorDetails}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="task-actions">
        {canRetry ? (
          <Button size="sm" variant="primary" icon="retry" onClick={() => void window.vidaud.retryPlaylistItem(job.playlistId, item.itemId)}>
            {t('task.retry')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

const PlaylistItemRowMemo = memo(
  (props: { job: PlaylistJob; item: PlaylistItem; displayIndex?: number }) => <PlaylistItemRow {...props} />,
  (prev, next) => prev.displayIndex === next.displayIndex && prev.job.playlistId === next.job.playlistId && !itemChanged(prev.item, next.item)
)

/** Estimated height of one playlist row; virtualization only needs an estimate. */
const PLAYLIST_ROW_HEIGHT = 72

/**
 * Renders playlist rows windowed so a 2000-item playlist never mounts 2000
 * DOM nodes at once. The container scrolls; only the visible window plus a
 * small overscan is mounted, and the spacer keeps the scrollbar true.
 */
function PlaylistItems({ job, items }: { job: PlaylistJob; items: PlaylistItem[] }): JSX.Element {
  const [scrollTop, setScrollTop] = useState(0)
  const overscan = 4
  const viewportRows = Math.ceil(460 / PLAYLIST_ROW_HEIGHT) + overscan * 2
  const start = Math.max(0, Math.floor(scrollTop / PLAYLIST_ROW_HEIGHT) - overscan)
  const end = Math.min(items.length, start + viewportRows)
  const visibleItems = items.slice(start, end)

  return (
    <div style={{ marginTop: 8, maxHeight: 460, overflowY: 'auto' }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: items.length * PLAYLIST_ROW_HEIGHT, position: 'relative' }}>
        {visibleItems.map((item, i) => {
          const idx = start + i
          return (
            <div key={item.itemId} style={{ position: 'absolute', top: idx * PLAYLIST_ROW_HEIGHT, left: 0, right: 0 }}>
              <PlaylistItemRowMemo job={job} item={item} displayIndex={idx + 1} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PlaylistSection({ job }: { job: PlaylistJob }): JSX.Element {
  const { t } = useI18n()
  const { confirm } = useApp()
  const [expanded, setExpanded] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const stats = useMemo(() => {
    const items = job.items.filter((i) => i.status !== 'Unavailable' && hasRealTitle(i.title))
    return computeStats({ ...job, items })
  }, [job])
  const failedCount = stats.failed
  const items = [...job.items]
    .filter((i) => i.status !== 'Unavailable' && hasRealTitle(i.title))
    .sort((a, b) => a.index - b.index)
  const canRetryFailed = failedCount > 0
  const headerIcon = expanded ? 'cancel' : 'arrowDown'
  const doneAll = stats.total > 0 && stats.completed + stats.cancelled === stats.total
  const finishedLabel = doneAll ? (stats.failed > 0 ? t('playlists.finished') : t('playlists.completedAll')) : t('playlists.inProgress')

  const handleDeletePlaylist = async (): Promise<void> => {
    if (isDeleting) return

    const ok = await confirm({
      title: t('confirm.deletePlaylist'),
      message: t('confirm.deletePlaylistMessage'),
      detail: t('confirm.filesNotDeleted'),
      danger: true
    })
    if (!ok) return
    setIsDeleting(true)
    try {
      await window.vidaud.removePlaylist(job.playlistId)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div
        className="task-item"
        style={{ flexDirection: 'column', gap: 10, cursor: 'pointer', padding: 0, border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }} onClick={() => setExpanded((v) => !v)}>
          <Icon name="list" size={16} />
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.playlistTitle}>
            {job.playlistTitle || t('dashboard.playlist')}
          </span>
          <span className="badge accent" style={{ marginInlineStart: 'auto', flex: '0 0 auto' }}>
            {stats.completed} / {stats.total}
          </span>
          <button className="icon-btn" title={t(expanded ? 'playlists.hideItems' : 'playlists.showItems')}>
            <Icon name={headerIcon} size={14} />
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px' }}>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-input)', overflow: 'hidden', display: 'flex' }}>
            {stats.total > 0 ? (
              <>
                <div style={{ height: '100%', background: 'var(--success)', width: `${(stats.completed / stats.total) * 100}%` }} />
                <div style={{ height: '100%', background: 'var(--accent)', width: `${((stats.downloading + stats.analyzing + stats.queued + stats.retrying) / stats.total) * 100}%` }} />
                <div style={{ height: '100%', background: 'var(--danger)', width: `${(failedCount / stats.total) * 100}%` }} />
              </>
            ) : null}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '0 12px 10px' }}>
          <span className="badge" style={{ color: 'var(--text-dim)' }}>
            {t('playlists.queued')}: {stats.queued + stats.analyzing + stats.downloading + stats.retrying}
          </span>
          <span className="badge success">
            {t('playlists.completed')}: {stats.completed}
          </span>
          {stats.failed > 0 ? (
            <span className="badge danger">
              {t('playlists.failed')}: {stats.failed}
            </span>
          ) : null}
          <span className="badge" style={{ marginInlineStart: 'auto' }}>
            {finishedLabel}
          </span>
          {canRetryFailed ? (
            <Button size="sm" variant="primary" icon="retry" onClick={() => void window.vidaud.retryPlaylistFailed(job.playlistId)}>
              {t('playlists.retryFailed')}
            </Button>
          ) : null}
          <button
            className="icon-btn"
            title={t('confirm.deletePlaylist')}
            disabled={isDeleting}
            onClick={() => void handleDeletePlaylist()}
            style={{ marginInlineStart: canRetryFailed ? 0 : 'auto', opacity: isDeleting ? 0.5 : 1 }}
          >
            <Icon name="remove" size={15} />
          </button>
        </div>
      </div>
      {expanded ? (
        <PlaylistItems job={job} items={items} />
      ) : null}
    </div>
  )
}

function jobChanged(a: PlaylistJob, b: PlaylistJob): boolean {
  if (a.playlistTitle !== b.playlistTitle || a.totalItems !== b.totalItems) return true
  if (a.items.length !== b.items.length) return true
  for (let i = 0; i < a.items.length; i++) {
    if (itemChanged(a.items[i], b.items[i])) return true
  }
  return false
}

const PlaylistSectionMemo = memo(PlaylistSection, (prev, next) => !jobChanged(prev.job, next.job))

interface DownloadsHeaderControlsProps {
  hasActive: boolean
  hasCompleted: boolean
}

/**
 * The bulk controls above the download list. Pause All / Resume All are
 * non-destructive and call the engine immediately over IPC. Cancel All and
 * Clear Completed are destructive, so they first show the shared ConfirmDialog
 * (Yes/No) and the IPC request is sent only after the user presses Yes. The
 * enabled/disabled state derives from real engine state passed in as props
 * (`tasks`/`playlists` pushed from main via onQueue).
 */
function DownloadsHeaderControls({ hasActive, hasCompleted }: DownloadsHeaderControlsProps): JSX.Element {
  const { t } = useI18n()
  const { confirm, toast } = useApp()
  const [isCancelling, setIsCancelling] = useState(false)
  const [isClearing, setIsClearing] = useState(false)

  const handlePauseAll = (): void => {
    void window.vidaud.pauseAll()
  }

  const handleResumeAll = (): void => {
    void window.vidaud.resumeAll()
  }

  const handleCancelAll = async (): Promise<void> => {
    if (isCancelling) return
    const ok = await confirm({
      title: t('confirm.cancelDownloads'),
      message: t('confirm.cancelDownloadsMessage'),
      danger: true
    })
    if (!ok) return
    setIsCancelling(true)
    try {
      await window.vidaud.cancelAll()
    } finally {
      setIsCancelling(false)
    }
  }

  const handleClearCompleted = async (): Promise<void> => {
    if (isClearing) return
    const ok = await confirm({
      title: t('confirm.clearCompleted'),
      message: t('confirm.clearCompletedMessage'),
      detail: t('confirm.filesNotDeleted')
    })
    if (!ok) return
    setIsClearing(true)
    try {
      const result = await window.electronAPI.clearCompletedDownloads()
      if (!result.success) {
        toast('error', result.error ?? t('downloads.clearCompletedFailed'))
        return
      }
      if (result.count === 0) {
        toast('info', t('downloads.noCompleted'))
        return
      }
      toast('success', t('downloads.clearCompletedDone', { count: result.count }))
    } finally {
      setIsClearing(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
      <Button size="sm" icon="pause" disabled={!hasActive} onClick={handlePauseAll}>
        {t('downloads.pauseAll')}
      </Button>
      <Button size="sm" icon="resume" disabled={!hasActive} onClick={handleResumeAll}>
        {t('downloads.resumeAll')}
      </Button>
      <Button size="sm" variant="danger" icon="cancel" disabled={!hasActive || isCancelling} onClick={() => void handleCancelAll()}>
        {isCancelling ? t('downloads.cancelling') : t('downloads.cancelAll')}
      </Button>
      <Button size="sm" icon="remove" disabled={!hasCompleted || isClearing} onClick={() => void handleClearCompleted()}>
        {isClearing ? t('downloads.clearing') : t('downloads.clearCompleted')}
      </Button>
    </div>
  )
}

export function Downloads(): JSX.Element {
  const { tasks, playlists, setPage } = useApp()
  const { t } = useI18n()
  const hasActive = tasks.some((x) => x.state === 'Downloading' || x.state === 'Processing' || x.state === 'Converting' || x.state === 'Waiting' || x.state === 'Analyzing' || x.state === 'Retrying')
  const hasCompleted = tasks.some((x) => x.state === 'Completed') || playlists.some((j) => j.items.some((i) => i.status === 'Completed'))

  // Stable signature of everything that affects grouping/ordering: progress
  // ticks mutate only percent/speed/bytes, which never change group membership,
  // so the group arrays are not rebuilt at 8Hz just because the tasks array ref
  // changes (perf: task count is small, but group rebuild + sort is not free).
  const groupingSignature = useMemo(() => {
    return tasks.map((t) => `${t.id}|${t.state}|${t.playlistId ?? ''}|${t.playlistIndex ?? ''}|${t.playlistTitle ?? ''}|${t.title}`).join(';')
  }, [tasks])

  const { groups, standalone } = useMemo(() => {
    const byId = new Map<string, DownloadTask[]>()
    const singles: DownloadTask[] = []
    for (const task of tasks) {
      if (task.state === 'Unavailable') continue
      if (!hasRealTitle(task.title)) continue
      if (task.playlistId) {
        const arr = byId.get(task.playlistId) ?? []
        arr.push(task)
        byId.set(task.playlistId, arr)
      } else {
        singles.push(task)
      }
    }
    const g: PlaylistGroup[] = []
    for (const [key, arr] of byId) {
      const sorted = [...arr].sort((a, b) => (a.playlistIndex ?? 0) - (b.playlistIndex ?? 0))
      g.push({ key, title: sorted[0]?.playlistTitle ?? '', tasks: sorted })
    }
    return { groups: g, standalone: singles }
  }, [groupingSignature])

  return (
    <div>
      <DownloadsHeaderControls hasActive={hasActive} hasCompleted={hasCompleted} />

      {playlists.length > 0 ? (
        <div style={{ marginBottom: 18 }}>
          {playlists.map((job) => (
            <PlaylistSectionMemo key={job.playlistId} job={job} />
          ))}
        </div>
      ) : null}

      {tasks.length === 0 && playlists.length === 0 ? (
        <EmptyState icon="downloads" text={t('downloads.empty')} action={<Button variant="primary" onClick={() => setPage('dashboard')}>{t('downloads.emptyAction')}</Button>} />
      ) : (
        <>
          {groups.map((g) => {
            const done = g.tasks.filter((x) => x.state === 'Completed').length
            const total = g.tasks[0]?.playlistCount ?? g.tasks.length
            return (
              <div key={g.key} style={{ marginBottom: 14 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    marginBottom: 8,
                    background: 'var(--glass)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: 'var(--radius)',
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)'
                  }}
                >
                  <Icon name="list" size={16} />
                  <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.title}>
                    {g.title || t('dashboard.playlist')}
                  </span>
                  <span className="badge accent" style={{ marginInlineStart: 'auto', flex: '0 0 auto' }}>
                    {t('downloads.playlistProgress', { done, total })}
                  </span>
                </div>
                {g.tasks.map((task) => (
                  <TaskItemMemo key={task.id} task={task} />
                ))}
              </div>
            )
          })}
          {standalone.map((task) => (
            <TaskItemMemo key={task.id} task={task} />
          ))}
        </>
      )}
    </div>
  )
}
