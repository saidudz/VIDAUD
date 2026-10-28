import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useApp } from '../AppContext'
import { useI18n } from '../i18n'
import { Button } from '../components/Button'
import { EmptyState, ProgressBar, formatBytes, formatDuration, formatEta } from '../components/ui'
import { Icon } from '../components/Icon'
import type { AdvancedOptions, ConverterJob, ConverterTarget, DetectedFile } from '@shared/types'

/** True when the backend reported this file as unusable for conversion. */
function isUnsupported(d: DetectedFile): boolean {
  return d.category === 'unsupported' || d.targets.length === 0
}

const CATEGORY_LABEL: Record<string, string> = {
  video: 'converter.video',
  audio: 'converter.audio',
  image: 'converter.image',
  pdf: 'converter.pdf'
}

function categoryIcon(cat: string): 'video' | 'music' | 'eye' | 'document' {
  if (cat === 'video') return 'video'
  if (cat === 'image') return 'eye'
  if (cat === 'pdf') return 'document'
  return 'music'
}

function targetSortKey(target: ConverterTarget): string {
  if (target.kind === 'video') return `0-${target.label}`
  if (target.kind === 'audio') return `1-${target.label}`
  return `2-${target.label}`
}

// Advanced options are passed straight to FFmpeg; only encoders the bundled
// engine actually ships are offered here (verified against the FFmpeg build).
const VIDEO_ENCODERS = [
  'libx264', 'libx265', 'libvpx-vp9', 'libvpx', 'mpeg4', 'mpeg2video',
  'msmpeg4v2', 'wmv2', 'mjpeg', 'libtheora', 'prores_ks', 'dnxhd'
]
const AUDIO_ENCODERS = [
  'aac', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'ac3', 'eac3',
  'pcm_s16le', 'alac', 'wmav2', 'mp2'
]
const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']
const SAMPLE_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000]
const CHANNELS = [1, 2, 6]

const JOB_STATE_TONE: Record<string, string> = {
  Waiting: 'accent',
  Converting: 'accent',
  Processing: 'accent',
  Completed: 'success',
  Failed: 'danger',
  Cancelled: 'warning'
}

export function Converter(): JSX.Element {
  const { converterJobs, setConverterJobs, toast } = useApp()
  const { t } = useI18n()
  const [detected, setDetected] = useState<DetectedFile[]>([])
  const [targetsByPath, setTargetsByPath] = useState<Record<string, string>>({})
  const [advancedByPath, setAdvancedByPath] = useState<Record<string, AdvancedOptions>>({})
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({})
  const [openPanels, setOpenPanels] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState(false)
  const [addingProgress, setAddingProgress] = useState<{ done: number; total: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [convertingIds, setConvertingIds] = useState<string[]>([])
  const [etas, setEtas] = useState<Record<string, number>>({})
  const busyRef = useRef(false)
  const detectedRef = useRef<DetectedFile[]>([])
  const dropRef = useRef<HTMLDivElement | null>(null)
  const thumbLoadedRef = useRef<Record<string, boolean>>({})
  const snapRef = useRef<Record<string, { percent: number; at: number }>>({})

  // Live per-file progress while a batch is being classified ("Adding files… 25/100").
  useEffect(() => {
    const off = window.vidaud.onConverterDetectProgress((p) => {
      setAddingProgress({ done: p.done, total: p.total })
    })
    return off
  }, [])

  // High-frequency conversion progress → smoothed per-job ETA.
  useEffect(() => {
    const off = window.vidaud.onConverterProgress((p) => {
      if (p.percent == null) return
      const prev = snapRef.current[p.id]
      const now = Date.now()
      if (prev && p.percent > prev.percent) {
        const dt = (now - prev.at) / 1000
        const dp = p.percent - prev.percent
        if (dt > 0.3 && dp > 0) {
          const eta = (100 - p.percent) / (dp / dt)
          if (Number.isFinite(eta)) {
            setEtas((prevEtas) => ({ ...prevEtas, [p.id]: Math.max(1, Math.round(eta)) }))
          }
        }
      }
      snapRef.current[p.id] = { percent: p.percent, at: now }
    })
    return off
  }, [])

  const loadThumb = useCallback((path: string): void => {
    if (thumbLoadedRef.current[path]) return
    thumbLoadedRef.current[path] = true
    window.vidaud
      .getFileThumbnail(path)
      .then((url) => setThumbnails((prev) => (prev[path] === undefined ? { ...prev, [path]: url } : prev)))
      .catch(() => setThumbnails((prev) => (prev[path] === undefined ? { ...prev, [path]: null } : prev)))
  }, [])

  // Any job card also gets a thumbnail (e.g. restored jobs after restart).
  useEffect(() => {
    for (const job of converterJobs) {
      if (!thumbLoadedRef.current[job.inputPath]) loadThumb(job.inputPath)
    }
  }, [converterJobs, loadThumb])

  const setTargetFor = (path: string, id: string): void => {
    setTargetsByPath((prev) => ({ ...prev, [path]: id }))
  }

  const setAdvancedFor = (path: string, adv: AdvancedOptions): void => {
    setAdvancedByPath((prev) => ({ ...prev, [path]: adv }))
  }

  const togglePanel = (key: string): void => {
    setOpenPanels((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const registerFiles = useCallback(
    async (paths: string[]): Promise<void> => {
      const clean = paths.filter((p) => typeof p === 'string' && p.trim().length > 0)
      if (clean.length === 0) return
      if (busyRef.current) return
      busyRef.current = true
      setAdding(true)
      setAddingProgress({ done: 0, total: clean.length })
      try {
        const results = await window.vidaud.detectFiles(clean)
        const seen = new Set<string>()
        const merged = results.filter((d) => {
          if (seen.has(d.path)) return false
          seen.add(d.path)
          return true
        })
        // Deduplicate against what is already on the page (absoluteFilePath = unique id).
        const existing = new Set(detectedRef.current.map((d) => d.path))
        const fresh = merged.filter((d) => !existing.has(d.path))
        if (fresh.length > 0) {
          detectedRef.current = [...fresh, ...detectedRef.current]
          setDetected(detectedRef.current)
        }
        setTargetsByPath((prev) => {
          const next = { ...prev }
          for (const d of merged) {
            if (d.targets && d.targets.length > 0 && !next[d.path]) {
              next[d.path] = d.targets[0].id
            }
          }
          return next
        })
        for (const d of fresh) loadThumb(d.path)
        const addedCount = fresh.filter((d) => !isUnsupported(d)).length
        const skippedCount = fresh.filter((d) => isUnsupported(d)).length
        if (addedCount > 0) {
          toast('success', t('converter.filesAdded').replace('{n}', String(addedCount)))
        }
        if (skippedCount > 0) {
          // Unsupported rows are still shown (greyed) so the user sees exactly
          // what was skipped from conversion.
          toast('info', t('converter.unsupportedSkipped').replace('{n}', String(skippedCount)))
        }
      } catch (e) {
        console.error('[VIDAUD][CONVERTER] detect failed', e)
        toast('error', t('converter.detectFailed'))
      } finally {
        busyRef.current = false
        setAdding(false)
        setAddingProgress(null)
      }
    },
    [toast, t, loadThumb]
  )

  const handlePick = async (): Promise<void> => {
    try {
      const paths = await window.vidaud.selectFiles()
      if (paths.length > 0) void registerFiles(paths)
    } catch (e) {
      console.error('[VIDAUD][CONVERTER] pick failed', e)
    }
  }

  const handlePickFolder = async (): Promise<void> => {
    try {
      const paths = await window.vidaud.selectFolder()
      if (paths.length === 0) {
        toast('info', t('converter.noSupportedFiles'))
        return
      }
      void registerFiles(paths)
    } catch (e) {
      console.error('[VIDAUD][CONVERTER] folder pick failed', e)
    }
  }

  const resolveDroppedFiles = useCallback(
    async (files: FileList): Promise<string[]> => {
      const paths: string[] = []
      for (const f of Array.from(files)) {
        try {
          const p = await window.vidaud.getPathForFile(f)
          if (p) paths.push(p)
        } catch {
          /* ignore unreadable files */
        }
      }
      if (paths.length === 0) return []
      // Dropped items may be folders: expand them into their supported files.
      return window.vidaud.expandPaths(paths)
    },
    []
  )

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragging(false)
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return
    void (async () => {
      const paths = await resolveDroppedFiles(e.dataTransfer.files)
      void registerFiles(paths)
    })()
  }

  const removeDetected = (path: string): void => {
    detectedRef.current = detectedRef.current.filter((d) => d.path !== path)
    setDetected(detectedRef.current)
    setTargetsByPath((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    setAdvancedByPath((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
  }

  const clearFiles = (): void => {
    detectedRef.current = []
    setDetected([])
    setTargetsByPath({})
    setAdvancedByPath({})
  }

  const startConvert = async (): Promise<void> => {
    const queueable = detected.filter(
      (d) => !isUnsupported(d) && d.targets.length > 0 && targetsByPath[d.path]
    )
    if (queueable.length === 0) {
      toast('error', t('converter.noFiles'))
      return
    }
    setConvertingIds(queueable.map((d) => d.path))
    try {
      // One IPC round-trip for the whole batch; each file keeps its own target
      // and its own advanced FFmpeg overrides.
      const items = queueable.map((d) => ({
        path: d.path,
        targetId: targetsByPath[d.path],
        advanced: advancedByPath[d.path]
      }))
      const res = await window.vidaud.convertFiles({ items })
      if (res.ok && (res.added ?? 0) > 0) {
        toast('success', t('converter.added').replace('{n}', String(res.added ?? 0)))
        const doneSet = new Set(queueable.map((d) => d.path))
        detectedRef.current = detectedRef.current.filter((d) => !doneSet.has(d.path))
        setDetected(detectedRef.current)
        setTargetsByPath((prev) => {
          const next = { ...prev }
          for (const d of queueable) delete next[d.path]
          return next
        })
        setAdvancedByPath((prev) => {
          const next = { ...prev }
          for (const d of queueable) delete next[d.path]
          return next
        })
      } else {
        toast('error', res.error || t('converter.addFailed'))
      }
    } catch {
      toast('error', t('converter.addFailed'))
    } finally {
      setConvertingIds([])
    }
  }

  const cancelJob = (id: string): void => {
    void window.vidaud.cancelConversion(id)
  }

  const retryJob = (id: string): void => {
    void window.vidaud.retryConversion(id)
  }

  const clearFinished = (): void => {
    void window.vidaud.clearFinishedConversions()
  }

  const clearAll = (): void => {
    void window.vidaud.clearAllConversions()
    setConverterJobs([])
  }

  const removable = detected.filter((d) => isUnsupported(d)).length
  const queueableCount = detected.filter((d) => !isUnsupported(d) && targetsByPath[d.path]).length
  const isEmpty = detected.length === 0 && converterJobs.length === 0
  const hasActiveJobs = converterJobs.some((j) => j.state === 'Converting' || j.state === 'Processing' || j.state === 'Waiting')

  const pdfFiles = useMemo(() => detected.filter((d) => d.category === 'pdf'), [detected])
  const hasMultiplePdfs = pdfFiles.length > 1

  const applyPdfSettingsToAll = (sourcePath: string): void => {
    const sourceTarget = targetsByPath[sourcePath]
    const sourceAdv = advancedByPath[sourcePath]
    if (!sourceTarget) return
    setTargetsByPath((prev) => {
      const next = { ...prev }
      for (const d of pdfFiles) {
        next[d.path] = sourceTarget
      }
      return next
    })
    if (sourceAdv) {
      setAdvancedByPath((prev) => {
        const next = { ...prev }
        for (const d of pdfFiles) {
          next[d.path] = { ...sourceAdv }
        }
        return next
      })
    }
    toast('success', t('converter.applyToAllPdfs'))
  }

  return (
    <div>
      <div className="converter-header">
        <div className="converter-header-title">
          <h2>{t('converter.title')}</h2>
          <p>{t('converter.subtitle')}</p>
        </div>
        <div className="converter-header-actions">
          <Button variant="primary" icon="download" onClick={() => void handlePick()}>
            {t('converter.addFiles')}
          </Button>
          <Button variant="secondary" icon="folder" onClick={() => void handlePickFolder()}>
            {t('converter.addFolder')}
          </Button>
          {detected.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={clearFiles}>
              {t('converter.clearAllFiles')}
            </Button>
          ) : null}
        </div>
      </div>

      <div
        ref={dropRef}
        role="button"
        tabIndex={0}
        onClick={() => void handlePick()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') void handlePick()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!dropRef.current?.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={handleDrop}
        className={`converter-dropzone ${dragging ? 'dragging' : ''}`}
      >
        <Icon name="download" size={26} />
        <div>
          <div className="converter-dropzone-label">
            {adding ? (
              <>
                {t('converter.addingFiles')}{' '}
                {addingProgress ? `${addingProgress.done} / ${addingProgress.total}` : ''}
              </>
            ) : (
              t('converter.addFiles')
            )}
          </div>
          <div className="converter-dropzone-hint">
            {dragging ? t('converter.dropActive') : t('converter.dropHint')}
          </div>
        </div>
      </div>

      {isEmpty ? <EmptyState icon="convert" text={t('converter.empty')} /> : null}

      {detected.length > 0 ? (
        <div className="converter-cards">
          {detected.map((d) => (
            <FileCard
              key={d.path}
              file={d}
              targetId={targetsByPath[d.path]}
              thumb={thumbnails[d.path] ?? null}
              open={!!openPanels[d.path]}
              advanced={advancedByPath[d.path] ?? {}}
              onTargetChange={(id) => setTargetFor(d.path, id)}
              onRemove={() => removeDetected(d.path)}
              onToggleDetails={() => togglePanel(d.path)}
              onAdvancedChange={(adv) => setAdvancedFor(d.path, adv)}
              hasMultiplePdfs={hasMultiplePdfs}
              onApplyToAllPdfs={() => applyPdfSettingsToAll(d.path)}
            />
          ))}
        </div>
      ) : null}

      {converterJobs.length > 0 ? (
        <div style={{ marginTop: 20 }}>
          <div className="converter-section-title">
            {t('converter.queueTitle')} ({converterJobs.length})
            <div style={{ flex: 1 }} />
            <button className="conv-expand-btn" onClick={clearFinished}>
              {t('converter.clearFinished')}
            </button>
            <button className="conv-expand-btn" onClick={clearAll} disabled={hasActiveJobs}>
              {t('converter.clearAll')}
            </button>
          </div>
          <div className="converter-cards">
            {converterJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                thumb={thumbnails[job.inputPath] ?? null}
                eta={etas[job.id]}
                open={!!openPanels[job.id]}
                onCancel={() => cancelJob(job.id)}
                onRetry={() => retryJob(job.id)}
                onToggleDetails={() => togglePanel(job.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {detected.length > 0 ? (
        <div className="converter-bottom">
          <div className="converter-bottom-ready">
            <Icon name="listChecks" size={16} />
            <span>{t('converter.filesReady', { n: queueableCount })}</span>
          </div>
          {removable > 0 ? (
            <span className="converter-bottom-unsupported">
              {t('converter.unsupportedNote', { n: removable })}
            </span>
          ) : null}
          <div style={{ flex: 1 }} />
          <Button
            variant="primary"
            icon="convert"
            disabled={queueableCount === 0 || adding || convertingIds.length > 0}
            onClick={() => void startConvert()}
          >
            {convertingIds.length > 0 ? t('converter.converting') : t('converter.convertAll')} ({queueableCount})
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function FileCard({
  file,
  targetId,
  thumb,
  open,
  advanced,
  onTargetChange,
  onRemove,
  onToggleDetails,
  onAdvancedChange,
  onApplyToAllPdfs,
  hasMultiplePdfs
}: {
  file: DetectedFile
  targetId: string
  thumb: string | null
  open: boolean
  advanced: AdvancedOptions
  onTargetChange: (id: string) => void
  onRemove: () => void
  onToggleDetails: () => void
  onAdvancedChange: (adv: AdvancedOptions) => void
  onApplyToAllPdfs?: () => void
  hasMultiplePdfs?: boolean
}): JSX.Element {
  const { t } = useI18n()
  const unsupported = isUnsupported(file)
  const isPdf = file.category === 'pdf'
  const isPdfDoc = isPdf && (targetId === 'docx' || targetId === 'txt' || targetId === 'html' || targetId === 'rtf' || targetId === 'md')
  const isPdfImage = isPdf && !isPdfDoc

  const sorted = useMemo(() => {
    return [...file.targets].sort((a, b) => {
      if (a.group && b.group && a.group !== b.group) {
        return a.group.localeCompare(b.group)
      }
      return targetSortKey(a).localeCompare(targetSortKey(b))
    })
  }, [file.targets])

  const setAdv = (patch: Partial<AdvancedOptions>): void => {
    onAdvancedChange({ ...advanced, ...patch })
  }
  const num = (v: string): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }

  // Grouped targets for select optgroups
  const imageTargets = useMemo(() => sorted.filter((t) => t.group === 'Image' || t.kind === 'image'), [sorted])
  const docTargets = useMemo(() => sorted.filter((t) => t.group === 'Document' || t.kind === 'document'), [sorted])
  const otherTargets = useMemo(() => sorted.filter((t) => t.group !== 'Image' && t.group !== 'Document' && t.kind !== 'image' && t.kind !== 'document'), [sorted])

  return (
    <div className={`conv-card ${unsupported ? 'unsupported' : ''}`}>
      <div className="conv-card-top">
        <div className="conv-thumb">
          {thumb ? (
            <img src={thumb} alt="" draggable={false} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <div className="fallback">
              <Icon name={categoryIcon(file.category)} size={26} />
            </div>
          )}
        </div>

        <div className="conv-body">
          <div className="conv-title-row">
            <span className="conv-title" title={file.path}>
              {file.name}
            </span>
            {unsupported ? (
              <span className="badge danger">{t('converter.unsupportedBadge')}</span>
            ) : (
              <span className="badge accent">{t(CATEGORY_LABEL[file.category] ?? 'converter.video')}</span>
            )}
            {file.pageCount && file.pageCount > 0 ? (
              <span className="badge" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {t('converter.pages', { n: file.pageCount })}
              </span>
            ) : null}
            {file.width && file.height ? (
              <span className="badge" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {file.width}×{file.height}
              </span>
            ) : null}
          </div>
          <div className="conv-meta">
            <span>{file.extension.toUpperCase()}</span>
            <span>{formatBytes(file.size)}</span>
            {file.pageCount && file.pageCount > 0 ? <span>{file.pageCount} {t('converter.pages', { n: file.pageCount })}</span> : null}
            {file.duration && file.duration > 0 ? <span>{formatDuration(file.duration)}</span> : null}
          </div>
          {unsupported && file.unsupportedReason ? (
            <div className="conv-error">
              {t('converter.unsupportedTitle')}: {file.unsupportedReason}
            </div>
          ) : null}
        </div>

        <div className="conv-side">
          {unsupported ? (
            <span className="badge danger">{t('converter.unsupportedTitle')}</span>
          ) : (
            <select
              className="select"
              style={{ minWidth: 160 }}
              value={targetId ?? ''}
              onChange={(e) => onTargetChange(e.target.value)}
            >
              <option value="" disabled>
                {t('converter.chooseOutput')}
              </option>
              {isPdf ? (
                <>
                  {imageTargets.length > 0 ? (
                    <optgroup label={t('converter.imagesGroup')}>
                      {imageTargets.map((tg) => (
                        <option key={tg.id} value={tg.id}>
                          {tg.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {docTargets.length > 0 ? (
                    <optgroup label={t('converter.documentsGroup')}>
                      {docTargets.map((tg) => (
                        <option key={tg.id} value={tg.id}>
                          {tg.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </>
              ) : (
                sorted.map((tg) => (
                  <option key={tg.id} value={tg.id}>
                    {tg.label}
                  </option>
                ))
              )}
            </select>
          )}
          <div className="conv-actions">
            {!unsupported ? (
              <button className={`conv-expand-btn ${open ? 'open' : ''}`} onClick={onToggleDetails}>
                <Icon name="listChecks" size={14} />
                {t(open ? 'converter.hideDetails' : 'converter.showDetails')}
                <Icon name="arrowDown" size={12} className="chev" />
              </button>
            ) : null}
            <button className="icon-btn" title={t('converter.removeCard')} onClick={onRemove}>
              <Icon name="clear" size={15} />
            </button>
          </div>
        </div>
      </div>

      {open && !unsupported ? (
        <div className="conv-panel">
          <div className="conv-details-path" title={file.path}>
            {file.path}
          </div>
          <div className="conv-meta" style={{ marginTop: 8 }}>
            {isPdf ? <span>{file.pageCount || 1} {t('converter.pages', { n: file.pageCount || 1 })}</span> : null}
            {file.hasVideo ? <span>{t('converter.video')} ✓</span> : null}
            {file.hasAudio ? <span>{t('converter.audio')} ✓</span> : null}
            {file.width && file.height ? (
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {file.width}×{file.height}
              </span>
            ) : null}
            {file.duration && file.duration > 0 ? <span>{formatDuration(file.duration)}</span> : null}
            {file.probed ? <span>Verified ✓</span> : null}
          </div>

          {/* PDF-Specific Controls */}
          {isPdf ? (
            <div className="adv-grid" style={{ marginTop: 12 }}>
              {isPdfImage ? (
                <>
                  <div className="adv-field">
                    <label>{t('converter.pdfDpi')}</label>
                    <select
                      className="select"
                      value={advanced.pdfDpi ?? 150}
                      onChange={(e) => setAdv({ pdfDpi: num(e.target.value) || 150 })}
                    >
                      <option value="72">72 DPI (Web)</option>
                      <option value="96">96 DPI (Standard)</option>
                      <option value="150">150 DPI (Balanced - Default)</option>
                      <option value="200">200 DPI (High)</option>
                      <option value="300">300 DPI (Print Quality)</option>
                      <option value="600">600 DPI (Ultra)</option>
                    </select>
                  </div>

                  {(targetId === 'jpg' || targetId === 'webp') ? (
                    <div className="adv-field">
                      <label>{t('converter.pdfQuality')} (1-100)</label>
                      <select
                        className="select"
                        value={advanced.pdfQuality ?? 90}
                        onChange={(e) => setAdv({ pdfQuality: num(e.target.value) || 90 })}
                      >
                        <option value="100">100 (Maximum)</option>
                        <option value="90">90 (Very High - Default)</option>
                        <option value="80">80 (High)</option>
                        <option value="70">70 (Medium)</option>
                        <option value="60">60 (Compact)</option>
                      </select>
                    </div>
                  ) : null}

                  <div className="adv-field">
                    <label>{t('converter.pdfPages')}</label>
                    <select
                      className="select"
                      value={advanced.pdfPageRangeMode ?? 'all'}
                      onChange={(e) => setAdv({ pdfPageRangeMode: e.target.value as 'all' | 'range' })}
                    >
                      <option value="all">{t('converter.pdfAllPages')}</option>
                      <option value="range">{t('converter.pdfPageRange')}</option>
                    </select>
                  </div>

                  {advanced.pdfPageRangeMode === 'range' ? (
                    <>
                      <div className="adv-field">
                        <label>{t('converter.pdfFrom')}</label>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={file.pageCount || 9999}
                          placeholder="1"
                          value={advanced.pdfPageRangeStart ?? 1}
                          onChange={(e) => setAdv({ pdfPageRangeStart: num(e.target.value) || 1 })}
                        />
                      </div>
                      <div className="adv-field">
                        <label>{t('converter.pdfTo')}</label>
                        <input
                          className="input"
                          type="number"
                          min={advanced.pdfPageRangeStart || 1}
                          max={file.pageCount || 9999}
                          placeholder={String(file.pageCount || 1)}
                          value={advanced.pdfPageRangeEnd ?? (file.pageCount || 1)}
                          onChange={(e) => setAdv({ pdfPageRangeEnd: num(e.target.value) || file.pageCount || 1 })}
                        />
                      </div>
                    </>
                  ) : null}
                </>
              ) : (
                <div style={{ gridColumn: '1 / -1', padding: '8px 12px', background: 'var(--bg-hover)', borderRadius: '8px', border: '1px solid var(--glass-border)', fontSize: '12.5px', color: 'var(--text-dim)' }}>
                  📄 {t('converter.pdfDocNote')}
                </div>
              )}

              <div className="adv-field" style={{ gridColumn: isPdfDoc ? '1 / -1' : undefined }}>
                <label>{t('converter.pdfPassword')}</label>
                <input
                  className="input"
                  type="password"
                  placeholder="Optional"
                  value={advanced.pdfPassword ?? ''}
                  onChange={(e) => setAdv({ pdfPassword: e.target.value || undefined })}
                />
              </div>

              {hasMultiplePdfs && onApplyToAllPdfs ? (
                <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
                  <Button size="sm" variant="secondary" onClick={onApplyToAllPdfs}>
                    {t('converter.applyToAllPdfs')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            /* Media / Video / Audio advanced controls */
            <div className="adv-grid" style={{ marginTop: 12 }}>
              {file.category === 'video' || file.category === 'audio' ? (
                <>
                  <div className="adv-field">
                    <label>{t('adv.audioCodec')}</label>
                    <select
                      className="select"
                      value={advanced.audioCodec ?? ''}
                      onChange={(e) => setAdv({ audioCodec: e.target.value || undefined })}
                    >
                      <option value="">{t('converter.auto')}</option>
                      {AUDIO_ENCODERS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="adv-field">
                    <label>{t('adv.audioBitrate')} (kbps)</label>
                    <input
                      className="input"
                      type="number"
                      min={8}
                      step={8}
                      placeholder="192"
                      value={advanced.audioBitrate ?? ''}
                      onChange={(e) => setAdv({ audioBitrate: num(e.target.value) })}
                    />
                  </div>
                  <div className="adv-field">
                    <label>{t('adv.sampleRate')} (Hz)</label>
                    <select
                      className="select"
                      value={advanced.sampleRate ?? ''}
                      onChange={(e) => setAdv({ sampleRate: num(e.target.value) })}
                    >
                      <option value="">{t('converter.auto')}</option>
                      {SAMPLE_RATES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="adv-field">
                    <label>{t('adv.channels')}</label>
                    <select
                      className="select"
                      value={advanced.channels ?? ''}
                      onChange={(e) => setAdv({ channels: num(e.target.value) })}
                    >
                      <option value="">{t('converter.auto')}</option>
                      {CHANNELS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : null}
              {file.category === 'video' ? (
                <>
                  <div className="adv-field">
                    <label>{t('adv.videoCodec')}</label>
                    <select
                      className="select"
                      value={advanced.videoCodec ?? ''}
                      onChange={(e) => setAdv({ videoCodec: e.target.value || undefined })}
                    >
                      <option value="">{t('converter.auto')}</option>
                      {VIDEO_ENCODERS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="adv-field">
                    <label>{t('adv.crf')}</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={51}
                      placeholder="20"
                      value={advanced.crf ?? ''}
                      onChange={(e) => setAdv({ crf: num(e.target.value) })}
                    />
                  </div>
                  <div className="adv-field">
                    <label>{t('adv.preset')}</label>
                    <select
                      className="select"
                      value={advanced.preset ?? ''}
                      onChange={(e) => setAdv({ preset: e.target.value || undefined })}
                    >
                      <option value="">{t('converter.auto')}</option>
                      {PRESETS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="adv-field">
                    <label>{t('adv.videoBitrate')} (kbps)</label>
                    <input
                      className="input"
                      type="number"
                      min={16}
                      step={16}
                      placeholder="Auto"
                      value={advanced.videoBitrate ?? ''}
                      onChange={(e) => setAdv({ videoBitrate: num(e.target.value) })}
                    />
                  </div>
                  <div className="adv-field">
                    <label>{t('adv.resolution')}</label>
                    <input
                      className="input"
                      type="number"
                      min={16}
                      step={16}
                      placeholder="Auto"
                      value={advanced.resolution ?? ''}
                      onChange={(e) => setAdv({ resolution: num(e.target.value) })}
                    />
                  </div>
                  <div className="adv-field">
                    <label>{t('adv.fps')}</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={120}
                      placeholder="Auto"
                      value={advanced.fps ?? ''}
                      onChange={(e) => setAdv({ fps: num(e.target.value) })}
                    />
                  </div>
                </>
              ) : null}
              {file.category === 'image' ? (
                <div className="adv-field">
                  <label>{t('adv.crf')}</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={100}
                    placeholder="80"
                    value={advanced.crf ?? ''}
                    onChange={(e) => setAdv({ crf: num(e.target.value) })}
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function JobCard({
  job,
  thumb,
  eta,
  open,
  onCancel,
  onRetry,
  onToggleDetails
}: {
  job: ConverterJob
  thumb: string | null
  eta?: number
  open: boolean
  onCancel: () => void
  onRetry: () => void
  onToggleDetails: () => void
}): JSX.Element {
  const { t } = useI18n()
  const stateKey = job.state.toLowerCase() as 'waiting' | 'converting' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'ready' | 'validating'
  const tone = JOB_STATE_TONE[job.state] ?? 'accent'
  const active = job.state === 'Converting' || job.state === 'Processing' || job.state === 'Waiting'
  const showEta = (job.state === 'Converting' || job.state === 'Processing') && !!eta && job.progress.percent > 0 && job.progress.percent < 100

  return (
    <div className={`conv-card ${active ? 'running' : ''}`}>
      <div className="conv-card-top">
        <div className="conv-thumb">
          {thumb ? (
            <img src={thumb} alt="" draggable={false} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <div className="fallback">
              <Icon name={categoryIcon(job.inputCategory)} size={26} />
            </div>
          )}
        </div>

        <div className="conv-body">
          <div className="conv-title-row">
            <span className="conv-title">{job.inputName}</span>
            <span className={`badge ${tone}`}>{t(`converter.state.${stateKey}`)}</span>
          </div>
          <div className="conv-meta">
            <span>→ {job.targetLabel}</span>
            {job.outputName ? <span>{job.outputName}</span> : null}
            {job.pageCount ? <span>{t('converter.pages', { n: job.pageCount })}</span> : null}
            {job.attempt > 1 ? <span>{t('task.attempt', { n: job.attempt })}</span> : null}
          </div>
          {active || job.progress.percent > 0 ? (
            <div className="conv-progress-row">
              <ProgressBar
                percent={job.progress.percent}
                indeterminate={job.progress.indeterminate}
                tone={job.state === 'Failed' ? 'danger' : job.state === 'Completed' ? 'success' : undefined}
              />
              <span className="conv-progress-label">
                {job.progress.indeterminate ? '…' : `${Math.round(job.progress.percent)}%`}
              </span>
              {showEta ? (
                <span className="conv-progress-eta">{t('converter.eta', { time: formatEta(eta) })}</span>
              ) : null}
            </div>
          ) : null}
          {job.progress.message && active ? (
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
              {job.progress.message}
            </div>
          ) : null}
          {job.error ? (
            <div className="conv-error">
              {job.error}
              {job.errorDetails ? <div className="conv-error-details">{job.errorDetails}</div> : null}
            </div>
          ) : null}
        </div>

        <div className="conv-side">
          <div className="conv-actions">
            {active ? (
              <button className="icon-btn" title={t('converter.actions.cancel')} onClick={onCancel}>
                <Icon name="cancel" size={15} />
              </button>
            ) : null}
            {job.state === 'Failed' || job.state === 'Cancelled' ? (
              <button className="icon-btn" title={t('converter.actions.retry')} onClick={onRetry}>
                <Icon name="retry" size={15} />
              </button>
            ) : null}
            {job.state === 'Completed' && job.outputPath ? (
              <button className="icon-btn" title={t('converter.actions.openFolder')} onClick={() => void window.vidaud.openFolder(job.outputPath!)}>
                <Icon name="openFolder" size={15} />
              </button>
            ) : null}
            <button className={`conv-expand-btn ${open ? 'open' : ''}`} onClick={onToggleDetails}>
              <Icon name="listChecks" size={14} />
              {t(open ? 'converter.hideDetails' : 'converter.showDetails')}
              <Icon name="arrowDown" size={12} className="chev" />
            </button>
          </div>
        </div>
      </div>

      {open ? (
        <div className="conv-panel">
          <div className="conv-details-path" title={job.inputPath}>
            {job.inputPath}
          </div>
          <div className="conv-meta" style={{ marginTop: 8 }}>
            <span>{job.targetExtension.toUpperCase()}</span>
            {job.progress.message ? <span>{job.progress.message}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
