import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AdvancedOptions, DownloadRequest, FormatInfo, FormatStatus, MediaEntry, MediaInfo, PlaylistFolderPreview } from '@shared/types'
import { findUrlsInText } from '@shared/clipboard'
import { useApp } from '../AppContext'
import { useI18n } from '../i18n'
import { Button } from '../components/Button'
import { Card, StatCard, formatBytes, formatDuration } from '../components/ui'
import { Icon } from '../components/Icon'

const VIDEO_QUALITIES = ['best', '1080', '720', '480', '360']
const AUDIO_QUALITIES = ['bestaudio', '320', '256', '192', '128']

const VIDEO_CODECS = ['auto', 'libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'mpeg4']
const AUDIO_CODECS = ['auto', 'aac', 'mp3', 'opus', 'vorbis', 'flac']
const PRESETS = ['auto', 'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']

const STATUS_TONE: Record<FormatStatus, string> = { direct: 'success', convert: 'warning', unavailable: 'danger' }

export function Dashboard(): JSX.Element {
  const { settings, stats, saveSettings, toast, setPage, confirm } = useApp()
  const { t } = useI18n()

  const [url, setUrl] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [analyzeProg, setAnalyzeProg] = useState<{ done: number; total: number } | null>(null)
  const [media, setMedia] = useState<MediaInfo | null>(null)
  const [kind, setKind] = useState<'video' | 'audio'>('video')
  const [quality, setQuality] = useState<string>('best')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)

  const [formats, setFormats] = useState<{ video: FormatInfo[]; audio: FormatInfo[] } | null>(null)
  const [videoFormat, setVideoFormat] = useState('')
  const [audioFormat, setAudioFormat] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advanced, setAdvanced] = useState<AdvancedOptions>({})
  const [playlistFolder, setPlaylistFolder] = useState<PlaylistFolderPreview | null>(null)

  // Image-gallery (web / search page) results state.
  const [imgSelected, setImgSelected] = useState<Set<string>>(new Set())
  const [imgFilter, setImgFilter] = useState('all')
  const [imgMinW, setImgMinW] = useState('')
  const [imgMinH, setImgMinH] = useState('')
  const [imgHideSmall, setImgHideSmall] = useState(true)
  const [imgPage, setImgPage] = useState(0)

  useEffect(() => {
    const off = window.vidaud.onAnalyzeProgress((p) => {
      if (p.url !== url.trim()) return
      setAnalyzeProg({ done: p.done, total: p.total })
    })
    return () => off()
  }, [url])

  useEffect(() => {
    window.vidaud
      .getFormats()
      .then(setFormats)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!formats) return
    const v = formats.video.find((f) => f.id === settings?.defaultVideoFormat)?.id
    const a = formats.audio.find((f) => f.id === settings?.defaultAudioFormat)?.id
    setVideoFormat((cur) => cur || v || 'mp4')
    setAudioFormat((cur) => cur || a || 'mp3')
  }, [formats, settings?.defaultVideoFormat, settings?.defaultAudioFormat])

  const maxHeight = useMemo(() => (media && media.availableHeights.length > 0 ? Math.max(...media.availableHeights) : 0), [media])

  useEffect(() => {
    if (kind === 'video') setQuality(settings?.defaultVideoQuality ?? 'best')
    else setQuality(settings?.mp3Bitrate ?? '320')
  }, [kind, settings?.defaultVideoQuality, settings?.mp3Bitrate])

  useEffect(() => {
    if (media && media.type === 'playlist') {
      setSelected(new Set(media.entries.map((e) => e.id)))
    }
    if (media && media.type === 'image-gallery') {
      setImgSelected(new Set(media.entries.map((e) => e.id)))
      setImgPage(0)
    }
  }, [media])

  useEffect(() => {
    if (media && media.type === 'playlist' && settings?.createPlaylistFolder) {
      window.vidaud
        .resolvePlaylistFolder(media.playlistTitle ?? media.title)
        .then(setPlaylistFolder)
        .catch(() => setPlaylistFolder(null))
    } else {
      setPlaylistFolder(null)
    }
  }, [media, settings?.createPlaylistFolder])

  // Multiple URLs in one paste: the user picks — never silently choose one.
  const [pastedUrls, setPastedUrls] = useState<string[] | null>(null)

  const paste = useCallback(async () => {
    // Preferred path: the REAL Windows clipboard via the main process.
    // navigator.clipboard is unreliable inside the sandboxed Electron
    // renderer (it throws without clipboard-read permission), so it is only
    // a fallback. Never auto-analyze here: Paste only fills the input; the
    // user starts Analyze explicitly.
    let raw = ''
    try {
      if (window.electronAPI?.readClipboardText) {
        const res = await window.electronAPI.readClipboardText()
        if (!res.success) {
          toast('error', t('dashboard.clipboardReadFailed'), res.error)
          return
        }
        if (res.hasNonText) {
          toast('error', t('dashboard.clipboardNoText'))
          return
        }
        if (res.empty || !res.text) {
          toast('error', t('dashboard.clipboardEmpty'))
          return
        }
        raw = res.text
      } else {
        const text = await navigator.clipboard.readText()
        if (!text || !text.trim()) {
          toast('error', t('dashboard.clipboardEmpty'))
          return
        }
        raw = text.trim()
      }
    } catch {
      toast('error', t('dashboard.clipboardReadFailed'))
      return
    }
    const urls = findUrlsInText(raw)
    if (urls.length === 1) {
      setUrl(urls[0])
    } else if (urls.length > 1) {
      setPastedUrls(urls)
    } else {
      // Plain text without a URL: insert as-is so the user can edit it.
      // Analyze validates whether it is a usable link.
      setUrl(raw.trim())
    }
  }, [toast, t])

  const analyze = useCallback(async (forceNoCookies = false) => {
    const target = url.trim()
    if (!target) return
    setAnalyzing(true)
    setAnalyzeError(null)
    setAnalyzeProg(null)
    setMedia(null)
    try {
      const info = await window.vidaud.analyze(target, forceNoCookies)
      setMedia(info)
      setAnalyzeProg(null)
      if (info.error) {
        setAnalyzeError(info.error)
        setMedia(null)
      }
    } catch {
      setAnalyzeError(t('dashboard.analyzeFailed'))
      setMedia(null)
    } finally {
      setAnalyzing(false)
    }
  }, [url, t])

  const isSessionError = analyzeError && (analyzeError.includes('browser session') || analyzeError.includes('Chrome cookie'))

  const selectedFormatId = kind === 'video' ? videoFormat : audioFormat
  const currentFormats = kind === 'video' ? formats?.video : formats?.audio
  const selectedFormat = useMemo(() => currentFormats?.find((f) => f.id === selectedFormatId), [currentFormats, selectedFormatId])

  const statusOf = useCallback(
    (f: FormatInfo): FormatStatus => {
      if (!f.available) return 'unavailable'
      const fromSource = media?.formatSupport?.[f.id]
      if (fromSource) return fromSource
      return f.requiresConversion ? 'convert' : 'direct'
    },
    [media?.formatSupport]
  )

  const selectedStatus = selectedFormat ? statusOf(selectedFormat) : null

  const setFormat = useCallback(
    (id: string) => {
      if (kind === 'video') setVideoFormat(id)
      else setAudioFormat(id)
    },
    [kind]
  )

  const setAdvancedNum = useCallback(
    (key: keyof AdvancedOptions) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value
      const num = v === '' ? undefined : Number(v)
      setAdvanced((prev) => {
        const next = { ...prev } as Record<string, number | string | undefined>
        if (num === undefined || !Number.isFinite(num)) delete next[key]
        else next[key] = num
        return next as AdvancedOptions
      })
    },
    []
  )

  const guessImageFormat = useCallback((m: MediaInfo): string => {
    if (m.imageExt && /^[a-z0-9]+$/i.test(m.imageExt)) {
      const e = m.imageExt.toLowerCase()
      if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'svg'].includes(e)) return e === 'jpeg' ? 'jpg' : e === 'tif' ? 'tiff' : e
    }
    const src = `${m.thumbnail ?? ''} ${m.webpageUrl ?? ''}`.toLowerCase()
    const match = /\.([a-z0-9]+)(?:[?#]|$)/.exec(src.split(/[?#]/)[0].split('/').pop() ?? '')
    if (match) {
      const e = match[1]
      if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'svg'].includes(e)) return e === 'jpeg' ? 'jpg' : e === 'tif' ? 'tiff' : e
    }
    return 'jpg'
  }, [])

  const IMG_PAGE_SIZE = 50

  const imgFormatOf = useCallback((e: { format?: string; url: string }): string => {
    if (e.format && /^[a-z0-9]+$/i.test(e.format)) {
      const f = e.format.toLowerCase()
      if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'svg'].includes(f)) return f === 'jpeg' ? 'jpg' : f === 'tif' ? 'tiff' : f
    }
    const last = e.url.split(/[?#]/)[0].split('/').pop() ?? ''
    const m = /\.([a-z0-9]{2,5})$/i.exec(last)
    const ext = (m?.[1] ?? '').toLowerCase()
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'svg'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext === 'tif' ? 'tiff' : ext
    return 'other'
  }, [])

  const imgFiltered = useMemo(() => {
    if (!media || media.type !== 'image-gallery') return []
    const minW = Number(imgMinW) || 0
    const minH = Number(imgMinH) || 0
    return media.entries.filter((e) => {
      const f = imgFormatOf(e)
      if (imgFilter !== 'all' && f !== imgFilter) return false
      // Entries without declared dimensions always pass size filters —
      // dimensions are only known from markup, never by downloading.
      if (minW > 0 && e.width && e.width < minW) return false
      if (minH > 0 && e.height && e.height < minH) return false
      if (imgHideSmall) {
        if (e.width && e.height && e.width <= 64 && e.height <= 64) return false
        if (/favicon|apple-touch-icon|sprite|pixel|tracking|beacon|1x1/i.test(e.url)) return false
      }
      return true
    })
  }, [media, imgFilter, imgMinW, imgMinH, imgHideSmall, imgFormatOf])

  const imgPageCount = Math.max(1, Math.ceil(imgFiltered.length / IMG_PAGE_SIZE))
  const imgSafePage = Math.min(imgPage, imgPageCount - 1)
  const imgVisible = imgFiltered.slice(imgSafePage * IMG_PAGE_SIZE, imgSafePage * IMG_PAGE_SIZE + IMG_PAGE_SIZE)
  const imgSelectedFiltered = useMemo(() => imgFiltered.filter((e) => imgSelected.has(e.id)), [imgFiltered, imgSelected])

  const buildGalleryRequest = useCallback(
    (list: MediaEntry[]): DownloadRequest | null => {
      if (!media || media.type !== 'image-gallery') return null
      if (list.length === 0) {
        toast('error', t('dashboard.noSelection'))
        return null
      }
      // One standalone image job per entry through the existing queue: the
      // scheduler's concurrency limits apply, and each job keeps its own
      // retry/progress/history state (one failure never blocks the rest).
      // For image-search results, prefer the original URL for download.
      return {
        url: media.webpageUrl,
        kind: 'image',
        format: 'jpg',
        quality: 'best',
        title: media.title,
        thumbnail: media.thumbnail,
        entries: list.map((e) => ({
          id: e.id,
          url: e.originalUrl || e.url, // Use original URL for download if available
          title: e.title,
          index: e.index,
          thumbnail: e.thumbnail
        }))
      }
    },
    [media, t, toast]
  )

  const startGalleryDownload = useCallback(
    async (list: MediaEntry[]) => {
      const request = buildGalleryRequest(list)
      if (!request) return
      if (settings?.askBeforeStart) {
        const ok = await confirm({
          title: t('confirm.startDownload'),
          message: t('confirm.startDownloadMessage'),
          detail: t('dashboard.foundImages', { count: list.length })
        })
        if (!ok) return
      }
      setAdding(true)
      try {
        const res = await window.vidaud.download(request)
        if (res.ok) {
          toast('success', t('dashboard.imagesAdded', { count: res.taskIds.length }))
          setPage('downloads')
        } else {
          toast('error', res.error ?? t('error.unable'))
        }
      } catch (e) {
        toast('error', e instanceof Error ? e.message : t('error.unable'))
      } finally {
        setAdding(false)
      }
    },
    [buildGalleryRequest, settings?.askBeforeStart, confirm, t, toast, setPage]
  )

  const buildRequest = useCallback((): DownloadRequest | null => {
    if (!media) return null
    if (media.type === 'image') {
      const fmt = guessImageFormat(media)
      return {
        url: media.webpageUrl,
        kind: 'image',
        format: fmt,
        quality: 'best',
        title: media.title,
        thumbnail: media.thumbnail,
        duration: undefined,
        uploader: media.uploader,
        uploadDate: media.uploadDate,
        advanced: undefined
      }
    }
    const hasAdvanced = Object.keys(advanced).length > 0
    const base: DownloadRequest = {
      url: media.webpageUrl,
      kind,
      format: selectedFormatId,
      quality,
      title: media.title,
      thumbnail: media.thumbnail,
      duration: media.duration,
      uploader: media.uploader,
      uploadDate: media.uploadDate,
      advanced: hasAdvanced ? advanced : undefined
    }
    if (media.type === 'playlist') {
      const entries = media.entries.filter((e) => selected.has(e.id))
      if (entries.length === 0) {
        toast('error', t('dashboard.noSelection'))
        return null
      }
      return {
        ...base,
        url: media.webpageUrl,
        playlistId: media.playlistId,
        playlistTitle: media.playlistTitle ?? media.title,
        playlistUrl: media.webpageUrl,
        playlistCount: entries.length,
        entries: entries.map((e) => ({ id: e.id, url: e.url, title: e.title, index: e.index, duration: e.duration, thumbnail: e.thumbnail, uploader: e.uploader }))
      }
    }
    return base
  }, [media, kind, selectedFormatId, quality, advanced, selected, t, toast, guessImageFormat])

  const doDownload = useCallback(
    async (request: DownloadRequest) => {
      setAdding(true)
      try {
        const res = await window.vidaud.download(request)
        if (res.ok) {
          toast('success', t('dashboard.added'))
          setPage('downloads')
        } else {
          toast('error', res.error ?? t('error.unable'))
        }
      } catch (e) {
        toast('error', e instanceof Error ? e.message : t('error.unable'))
      } finally {
        setAdding(false)
      }
    },
    [t, toast, setPage]
  )

  const startDownload = useCallback(async () => {
    const request = buildRequest()
    if (!request) return
    if (settings?.askBeforeStart) {
      const ok = await confirm({
        title: t('confirm.startDownload'),
        message: t('confirm.startDownloadMessage'),
        detail:
          request.entries && request.entries.length > 1
            ? t('dashboard.entries', { count: request.entries.length })
            : `${request.format.toUpperCase()} · ${t(`quality.${request.quality}`)}`
      })
      if (!ok) return
    }
    await doDownload(request)
  }, [buildRequest, settings?.askBeforeStart, confirm, t, doDownload])

  const chooseFolder = useCallback(async () => {
    const res = await window.vidaud.chooseFolder()
    if (!res) return
    if (res.path) {
      await saveSettings({ downloadFolder: res.path })
      toast('success', t('settings.locationChanged'))
    } else if (res.error) {
      toast('error', res.error)
    }
  }, [saveSettings, toast, t])

  const clearAll = useCallback(() => {
    setUrl('')
    setMedia(null)
    setAnalyzeError(null)
  }, [])

  const selectedCount = media && media.type === 'playlist' ? media.entries.filter((e) => selected.has(e.id)).length : 1

  const videoOptions = VIDEO_QUALITIES.map((q) => {
    const height = q === 'best' ? 0 : Number(q)
    const supported = q === 'best' || maxHeight === 0 || height <= maxHeight
    return { key: q, label: t(`quality.${q}`), supported }
  })
  const audioOptions = AUDIO_QUALITIES.map((q) => ({ key: q, label: t(`quality.${q}`), supported: true }))
  const qualityOptions = kind === 'video' ? videoOptions : audioOptions

  return (
    <div>
      <div className="stats-grid">
        <StatCard label={t('dashboard.stats.active')} value={stats.active} icon="downloads" tone="accent" />
        <StatCard label={t('dashboard.stats.completed')} value={stats.completed} icon="checkCircle" tone="success" />
        <StatCard label={t('dashboard.stats.failed')} value={stats.failed} icon="warnCircle" tone="danger" />
        <StatCard label={t('dashboard.stats.total')} value={formatBytes(stats.totalBytes)} icon="arrowDown" tone="info" />
      </div>

      <Card title={t('dashboard.pasteUrl')}>
        <div className="url-row">
          <div className="url-input-wrap">
            <input
              className="input url-input"
              placeholder={t('dashboard.placeholder')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void analyze()
              }}
              spellCheck={false}
            />
            <div className="url-input-actions">
              <button className="btn btn-secondary btn-xs" onClick={() => void paste()}>
                <Icon name="paste" size={13} />
                {t('dashboard.paste')}
              </button>
              {url ? (
                <button className="btn btn-ghost btn-xs" onClick={clearAll}>
                  <Icon name="clear" size={13} />
                </button>
              ) : null}
            </div>
          </div>
          <Button variant="primary" icon="analyze" onClick={() => void analyze()} loading={analyzing} disabled={!url.trim()}>
            {analyzing ? t('dashboard.analyzing') : t('dashboard.analyze')}
          </Button>
        </div>

        {analyzeError ? (
          <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)', fontWeight: 500 }}>
              <Icon name="alert" size={16} />
              <span style={{ fontSize: 13.5 }}>{analyzeError}</span>
            </div>
            {isSessionError ? (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button size="xs" variant="primary" icon="refresh" onClick={() => void analyze()}>
                  {t('common.retry')}
                </Button>
                <Button size="xs" variant="secondary" icon="settings" onClick={() => setPage('settings')}>
                  {t('common.chooseBrowser')}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => void analyze(true)}>
                  {t('common.continueWithoutLogin')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {analyzing && analyzeProg ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 6 }}>
              <span>{t('dashboard.discoveringEntries')}</span>
              <span>
                {analyzeProg.done} / {analyzeProg.total}
              </span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-input)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  borderRadius: 3,
                  background: 'var(--accent)',
                  transition: 'width 200ms ease',
                  width: `${analyzeProg.total > 0 ? Math.min(100, (analyzeProg.done / analyzeProg.total) * 100) : 0}%`
                }}
              />
            </div>
          </div>
        ) : null}
      </Card>

      {pastedUrls ? (
        <div className="modal-overlay" onClick={() => setPastedUrls(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
            <h2 className="confirm-title">{t('dashboard.clipboardMultiTitle')}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '14px 0', maxHeight: 320, overflowY: 'auto' }}>
              {pastedUrls.map((u) => (
                <button
                  key={u}
                  className="btn btn-secondary btn-sm"
                  style={{ justifyContent: 'flex-start', overflow: 'hidden' }}
                  onClick={() => {
                    setUrl(u)
                    setPastedUrls(null)
                  }}
                  title={u}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u}</span>
                </button>
              ))}
            </div>
            <div className="confirm-actions">
              <Button size="sm" variant="secondary" onClick={() => setPastedUrls(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {media ? (
        <>
          <Card>
            <div className="media-card">
              {media.thumbnail ? <div className="media-thumb" style={{ backgroundImage: `url(${media.thumbnail})` }} /> : <div className="media-thumb" />}
              <div className="media-info">
                <div className="title">{media.title}</div>
                <div className="media-meta">
                  <span className={`badge ${media.type === 'playlist' ? 'warning' : 'accent'}`}>
                    <Icon name={media.type === 'playlist' || media.type === 'image-gallery' ? 'list' : media.type === 'image' ? 'eye' : 'play'} size={12} />
                    {media.type === 'playlist'
                      ? t('dashboard.playlist')
                      : media.type === 'image'
                        ? (t('dashboard.singleImage') || t('dashboard.image') || 'Image')
                        : media.type === 'image-gallery'
                          ? (t('dashboard.imageResults') || 'Image Results')
                          : t('dashboard.singleVideo')}
                  </span>
                  {media.type === 'image-gallery' ? (
                    <span className="badge">
                      <Icon name="listChecks" size={12} />
                      {t('dashboard.foundImages', { count: media.downloadableCount ?? media.entries.length })}
                    </span>
                  ) : null}
                  {media.type === 'image' ? (
                    <span className="badge">
                      {t('media.image') || 'Image'} • {(media.imageExt || guessImageFormat(media)).toUpperCase()}
                      {media.fileSize ? ` • ${formatBytes(media.fileSize)}` : ''}
                    </span>
                  ) : null}
                  {media.duration ? (
                    <span className="badge">
                      <Icon name="clock" size={12} />
                      {t('dashboard.duration')}: {formatDuration(media.duration)}
                    </span>
                  ) : null}
                  {media.type === 'playlist' && media.entryCount ? (
                    <span className="badge">
                      <Icon name="listChecks" size={12} />
                      {t('dashboard.playlistSummary', {
                        detected: media.entryCount,
                        downloadable: media.downloadableCount ?? media.entries.length,
                        excluded: media.excludedCount ?? 0
                      })}
                    </span>
                  ) : null}
                  {media.uploader ? <span className="badge">{t('media.uploader', { name: media.uploader })}</span> : null}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 'auto', alignItems: 'center' }}>
                  {media.type === 'image' ? (
                    <span className="badge accent" style={{ marginInlineStart: 0 }}>
                      {t('dashboard.image') || 'Image'} • {(media.imageExt || guessImageFormat(media)).toUpperCase()}
                    </span>
                  ) : media.type === 'image-gallery' ? (
                    <span className="badge accent" style={{ marginInlineStart: 0 }}>
                      {t('dashboard.ofEntries', { count: imgSelected.size })}
                    </span>
                  ) : (
                    <div className="tabs" style={{ flex: '0 0 auto', width: 300 }}>
                      <button className={`tab ${kind === 'video' ? 'active' : ''}`} onClick={() => setKind('video')}>
                        <Icon name="video" size={15} />
                        {t('dashboard.video')} · {selectedFormatId.toUpperCase()}
                      </button>
                      <button className={`tab ${kind === 'audio' ? 'active' : ''}`} onClick={() => setKind('audio')}>
                        <Icon name="music" size={15} />
                        {t('dashboard.audio')} · {audioFormat.toUpperCase() || 'MP3'}
                      </button>
                    </div>
                  )}
                  {media.type === 'playlist' ? (
                    <span className="badge accent" style={{ marginInlineStart: 'auto' }}>
                      {t('dashboard.ofEntries', { count: selectedCount })}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </Card>

          {media.type !== 'image' && media.type !== 'image-gallery' ? (
            <>
              <div style={{ height: 14 }} />

              <Card title={t('dashboard.format')}>
            {currentFormats && currentFormats.length > 0 ? (
              <>
                <div className="format-grid">
                  {currentFormats.map((f) => {
                    const st = statusOf(f)
                    return (
                      <button key={f.id} className={`format-chip ${selectedFormatId === f.id ? 'selected' : ''}`} disabled={st === 'unavailable'} onClick={() => setFormat(f.id)}>
                        <span className={`status ${st}`} />
                        <span className="ext">{f.id.toUpperCase()}</span>
                      </button>
                    )
                  })}
                </div>
                {selectedStatus ? (
                  <div className="status-row">
                    <span className={`badge ${STATUS_TONE[selectedStatus]}`}>{t(`formatStatus.${selectedStatus}`)}</span>
                    {selectedFormat ? <span>{t(`format.${selectedFormatId}`)}</span> : null}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="status-row">{t('dashboard.loadingFormats')}</div>
            )}
          </Card>

          <div style={{ height: 14 }} />

          <div className="stats-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Card title={t('dashboard.quality')}>
              <div className="chip-grid">
                {qualityOptions.map((opt) => (
                  <button
                    key={opt.key}
                    className={`chip ${quality === opt.key ? 'selected' : ''}`}
                    disabled={!opt.supported}
                    onClick={() => setQuality(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Card>
            <Card title={t('dashboard.downloadFolder')}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <div
                  className="input"
                  style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <Icon name="folder" size={15} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{settings?.downloadFolder || ''}</span>
                </div>
                <Button variant="secondary" icon="folder" onClick={() => void chooseFolder()}>
                  {t('dashboard.browse')}
                </Button>
              </div>
              {media.type === 'playlist' && playlistFolder ? (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <Icon name="list" size={14} />
                  <span style={{ color: 'var(--text-dim)', flex: '0 0 auto' }}>{t('dashboard.playlistFolder')}:</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={playlistFolder.folder}>
                    {playlistFolder.folder}
                  </span>
                  <button className="icon-btn" onClick={() => void window.vidaud.openPath(playlistFolder.folder)} title={t('task.openFolder')}>
                    <Icon name="openFolder" size={15} />
                  </button>
                </div>
              ) : null}
            </Card>
          </div>

          <div style={{ height: 14 }} />

          <Card>
            <button className={`adv-toggle ${showAdvanced ? 'open' : ''}`} onClick={() => setShowAdvanced((v) => !v)}>
              <Icon name="settings" size={13} />
              {showAdvanced ? t('dashboard.hideAdvanced') : t('dashboard.advanced')}
            </button>
            {showAdvanced ? (
              <div style={{ marginTop: 16 }}>
                <div className="adv-grid">
                  <div className="field adv-field">
                    <label>{t('adv.videoCodec')}</label>
                    <select
                      className="select"
                      value={advanced.videoCodec ?? 'auto'}
                      onChange={(e) => {
                        const v = e.target.value
                        setAdvanced((prev) => {
                          const next = { ...prev }
                          if (v === 'auto') delete next.videoCodec
                          else next.videoCodec = v
                          return next
                        })
                      }}
                    >
                      {VIDEO_CODECS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field adv-field">
                    <label>{t('adv.audioCodec')}</label>
                    <select
                      className="select"
                      value={advanced.audioCodec ?? 'auto'}
                      onChange={(e) => {
                        const v = e.target.value
                        setAdvanced((prev) => {
                          const next = { ...prev }
                          if (v === 'auto') delete next.audioCodec
                          else next.audioCodec = v
                          return next
                        })
                      }}
                    >
                      {AUDIO_CODECS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field adv-field">
                    <label>{t('adv.crf')}</label>
                    <input className="input" type="number" min={0} max={51} placeholder="auto" value={advanced.crf ?? ''} onChange={setAdvancedNum('crf')} />
                  </div>
                  <div className="field adv-field">
                    <label>{t('adv.preset')}</label>
                    <select
                      className="select"
                      value={advanced.preset ?? 'auto'}
                      onChange={(e) => {
                        const v = e.target.value
                        setAdvanced((prev) => {
                          const next = { ...prev }
                          if (v === 'auto') delete next.preset
                          else next.preset = v
                          return next
                        })
                      }}
                    >
                      {PRESETS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field adv-field">
                    <label>{t('adv.videoBitrate')}</label>
                    <input className="input" type="number" min={0} placeholder="kbps" value={advanced.videoBitrate ?? ''} onChange={setAdvancedNum('videoBitrate')} />
                  </div>
                  <div className="field adv-field">
                    <label>{t('adv.audioBitrate')}</label>
                    <input className="input" type="number" min={0} placeholder="kbps" value={advanced.audioBitrate ?? ''} onChange={setAdvancedNum('audioBitrate')} />
                  </div>
                  <div className="field adv-field">
                    <label>{t('adv.resolution')}</label>
                    <input className="input" type="number" min={0} placeholder="height" value={advanced.resolution ?? ''} onChange={setAdvancedNum('resolution')} />
                  </div>
                  <div className="field adv-field">
                    <label>{t('adv.fps')}</label>
                    <input className="input" type="number" min={0} placeholder="auto" value={advanced.fps ?? ''} onChange={setAdvancedNum('fps')} />
                  </div>
                  <div className="field adv-field">
                    <label>{t('adv.sampleRate')}</label>
                    <input className="input" type="number" min={0} placeholder="Hz" value={advanced.sampleRate ?? ''} onChange={setAdvancedNum('sampleRate')} />
                  </div>
                  <div className="field adv-field">
                    <label>{t('adv.channels')}</label>
                    <input className="input" type="number" min={1} max={8} placeholder="auto" value={advanced.channels ?? ''} onChange={setAdvancedNum('channels')} />
                  </div>
                </div>
              </div>
            ) : null}
          </Card>

          {media.type === 'playlist' ? (
            <>
              <div style={{ height: 14 }} />
              <Card title={t('dashboard.playlistTitle')}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <Button size="sm" onClick={() => setSelected(new Set(media.entries.map((e) => e.id)))}>
                    <Icon name="listChecks" size={14} />
                    {t('dashboard.selectAll')}
                  </Button>
                  <Button size="sm" onClick={() => setSelected(new Set())}>
                    {t('dashboard.deselectAll')}
                  </Button>
                </div>
                <div className="playlist">
                  {media.entries.map((e, idx) => (
                    <div
                      key={e.id}
                      className={`playlist-item ${selected.has(e.id) ? 'selected' : ''}`}
                      onClick={() => {
                        const next = new Set(selected)
                        if (next.has(e.id)) next.delete(e.id)
                        else next.add(e.id)
                        setSelected(next)
                      }}
                    >
                      {e.thumbnail ? <div className="thumb" style={{ backgroundImage: `url(${e.thumbnail})` }} /> : <div className="thumb" />}
                      <div className="meta">
                        <div className="t">
                          <span className="idx">{String(idx + 1).padStart(2, '0')}.</span>
                          {e.title}
                        </div>
                        <div className="s">{e.duration ? formatDuration(e.duration) : '—'}</div>
                      </div>
                      <Icon name={selected.has(e.id) ? 'check' : 'listChecks'} size={16} />
                    </div>
                  ))}
                </div>
              </Card>
            </>
          ) : null}
            </>
          ) : null}

          {media.type === 'image' || media.type === 'image-gallery' ? (
            <>
              <div style={{ height: 14 }} />
              <Card title={t('dashboard.downloadFolder')}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div
                    className="input"
                    style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <Icon name="folder" size={15} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{settings?.downloadFolder || ''}</span>
                  </div>
                  <Button variant="secondary" icon="folder" onClick={() => void chooseFolder()}>
                    {t('dashboard.browse')}
                  </Button>
                </div>
              </Card>
            </>
          ) : null}

          {media.type === 'image-gallery' ? (
            <>
              <div style={{ height: 14 }} />
              <Card title={`${t('dashboard.imageResults') || 'Image Results'} • ${t('dashboard.foundImages', { count: media.downloadableCount ?? media.entries.length })}`}>
                {media.imageGalleryKind === 'search' && (
                  <div style={{ marginBottom: 10, padding: 10, background: 'rgba(0, 122, 255, 0.1)', borderRadius: 6, border: '1px solid rgba(0, 122, 255, 0.2)', fontSize: 13 }}>
                    <strong>Image Search: </strong>
                    {(() => {
                      try {
                        const u = new URL(media.webpageUrl)
                        const q = u.searchParams.get('q') || u.searchParams.get('as_q')
                        if (q) return `Query: "${q}"`
                      } catch {}
                      return ''
                    })()}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button size="sm" onClick={() => setImgSelected(new Set(imgFiltered.map((e) => e.id)))}>
                    <Icon name="listChecks" size={14} />
                    {t('dashboard.selectAll')}
                  </Button>
                  <Button size="sm" onClick={() => setImgSelected(new Set())}>
                    {t('dashboard.deselectAll')}
                  </Button>
                  <select className="select" style={{ width: 'auto' }} value={imgFilter} onChange={(e) => { setImgFilter(e.target.value); setImgPage(0) }} aria-label={t('dashboard.filterFormat')}>
                    <option value="all">{t('dashboard.filterAll')}</option>
                    <option value="jpg">JPG</option>
                    <option value="png">PNG</option>
                    <option value="webp">WEBP</option>
                    <option value="gif">GIF</option>
                    <option value="svg">SVG</option>
                    <option value="other">Other</option>
                  </select>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--text-dim)' }}>
                    {t('dashboard.minWidth')}
                    <input className="input" type="number" min={0} placeholder="500" value={imgMinW} onChange={(e) => { setImgMinW(e.target.value); setImgPage(0) }} style={{ width: 76 }} />
                    {t('dashboard.px')}
                  </label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--text-dim)' }}>
                    {t('dashboard.minHeight')}
                    <input className="input" type="number" min={0} placeholder="500" value={imgMinH} onChange={(e) => { setImgMinH(e.target.value); setImgPage(0) }} style={{ width: 76 }} />
                    {t('dashboard.px')}
                  </label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--text-dim)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={imgHideSmall} onChange={(e) => { setImgHideSmall(e.target.checked); setImgPage(0) }} />
                    {t('dashboard.hideSmall')}
                  </label>
                </div>
                <div className="playlist">
                  {imgVisible.map((e) => {
                    const f = imgFormatOf(e)
                    const hasOriginal = e.originalAvailable !== false && e.originalUrl
                    return (
                      <div
                        key={e.id}
                        className={`playlist-item ${imgSelected.has(e.id) ? 'selected' : ''}`}
                        onClick={() => {
                          const next = new Set(imgSelected)
                          if (next.has(e.id)) next.delete(e.id)
                          else next.add(e.id)
                          setImgSelected(next)
                        }}
                      >
                        {e.thumbnail ? <img className="thumb" src={e.thumbnail} alt="" loading="lazy" /> : <div className="thumb" />}
                        <div className="meta">
                          <div className="t" title={e.title}>
                            {e.title}
                          </div>
                          <div className="s" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                            <span>{f.toUpperCase()}</span>
                            {e.width && e.height ? <span>• {e.width}×{e.height}</span> : null}
                            {e.source && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Source: {e.source}</span>}
                            {!hasOriginal && (
                              <span style={{ color: 'var(--warning)', fontSize: 11.5, fontWeight: 500 }}>
                                <Icon name="alert" size={12} />
                                Original unavailable
                              </span>
                            )}
                          </div>
                        </div>
                        <Icon name={imgSelected.has(e.id) ? 'check' : 'listChecks'} size={16} />
                      </div>
                    )
                  })}
                </div>
                {imgPageCount > 1 ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', justifyContent: 'center' }}>
                    <Button size="sm" disabled={imgSafePage === 0} onClick={() => setImgPage((p) => Math.max(0, p - 1))}>
                      {t('dashboard.prev')}
                    </Button>
                    <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
                      {t('dashboard.showing', { from: imgSafePage * IMG_PAGE_SIZE + 1, to: Math.min(imgFiltered.length, (imgSafePage + 1) * IMG_PAGE_SIZE), total: imgFiltered.length })}
                    </span>
                    <Button size="sm" disabled={imgSafePage >= imgPageCount - 1} onClick={() => setImgPage((p) => Math.min(imgPageCount - 1, p + 1))}>
                      {t('dashboard.next')}
                    </Button>
                  </div>
                ) : null}
              </Card>
            </>
          ) : null}

          <div style={{ height: 18 }} />

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {media.type === 'image-gallery' ? (
              <>
                <Button variant="success" icon="download" size="md" onClick={() => void startGalleryDownload(imgSelectedFiltered)} loading={adding} disabled={imgSelectedFiltered.length === 0}>
                  {adding ? t('dashboard.starting') : t('dashboard.downloadSelectedCount', { count: imgSelectedFiltered.length })}
                </Button>
                <Button variant="secondary" icon="download" size="md" onClick={() => void startGalleryDownload(imgFiltered)} loading={adding} disabled={imgFiltered.length === 0}>
                  {t('dashboard.downloadAllCount', { count: imgFiltered.length })}
                </Button>
              </>
            ) : (
              <Button variant="success" icon="download" size="md" onClick={() => void startDownload()} loading={adding} disabled={media.type === 'playlist' && selectedCount === 0}>
                {adding ? t('dashboard.starting') : t('dashboard.download')}
              </Button>
            )}
            {media.type === 'image' ? (
              <span className="badge">
                <Icon name="eye" size={12} />
                {(media.imageExt || guessImageFormat(media)).toUpperCase()}
                {media.fileSize ? ` • ${formatBytes(media.fileSize)}` : ''}
              </span>
            ) : (
              <>
                <span className="badge">
                  <Icon name={kind === 'video' ? 'video' : 'music'} size={12} />
                  {selectedFormatId.toUpperCase()} · {t(`quality.${quality}`)}
                </span>
                {selectedStatus ? <span className={`badge ${STATUS_TONE[selectedStatus]}`}>{t(`formatStatus.${selectedStatus}`)}</span> : null}
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
