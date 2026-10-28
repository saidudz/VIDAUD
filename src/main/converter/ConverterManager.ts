import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join, parse as parsePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { AdvancedOptions, AppSettings, ConversionRequest, ConverterJob, ConverterProgressPayload, DetectedFile } from '@shared/types'
import { IPC } from '@shared/types'
import { getFormat, type FormatDefinition } from '@shared/formats'
import { FfmpegManager } from '../ffmpeg/FfmpegManager'
import { FileDetector } from './FileDetector'
import { ThumbnailService } from './ThumbnailService'
import { getConverterTarget, extensionCategory, isPdfTarget, isPdfImageTarget, isPdfDocTarget } from './CapabilityMatrix'
import { PdfConverter, pdfPagePrefix, type PdfImageOutputFormat } from './PdfConverter'
import { PdfTextConverter, type PdfDocOutputFormat } from './PdfTextConverter'
import { SettingsManager } from '../settings/SettingsManager'
import { CompletedManager } from '../completed/CompletedManager'
import { HistoryManager } from '../history/HistoryManager'
import { fileSizeBytes, resolveFinalPath, sanitizeFilename } from '../utils/files'
import { logger } from '../utils/logger'

const STAGE_PREPARE = 'preparing'
const STAGE_CONVERT = 'converting'
const STAGE_EXTRACT = 'extracting'
const STAGE_IMAGE = 'processing'
const STAGE_VALIDATE = 'validating'

function normalizeCodec(codec?: string): string | undefined {
  if (!codec) return undefined
  return codec.toLowerCase().split(' ')[0]
}

function hasAdvanced(adv?: AdvancedOptions): boolean {
  return !!adv && Object.keys(adv).length > 0
}

/** Maps a 1-100 quality slider to ffmpeg `-q:v` (2 best .. 31 worst). */
function qualityToQV(quality?: number): string {
  if (!quality) return '2'
  const q = Math.round(31 - ((Math.min(100, Math.max(1, quality)) - 1) / 99) * 29)
  return String(Math.min(31, Math.max(2, q)))
}

function videoEncodeArgs(encoder: string, adv?: AdvancedOptions): string[] {
  const crf = adv?.crf ?? 20
  const preset = adv?.preset ?? 'veryfast'
  const args: string[] = ['-c:v', encoder]
  switch (encoder) {
    case 'libx264':
    case 'libx265':
      args.push('-preset', preset, '-pix_fmt', 'yuv420p')
      if (adv?.videoBitrate) args.push('-b:v', `${adv.videoBitrate}k`)
      else args.push('-crf', String(crf))
      break
    case 'libvpx-vp9':
    case 'libvpx':
    case 'libaom-av1':
      if (adv?.videoBitrate) args.push('-b:v', `${adv.videoBitrate}k`)
      else args.push('-crf', String(Math.max(15, Math.min(63, crf + 10))))
      if (encoder !== 'libaom-av1') args.push('-row-mt', '1')
      break
    case 'mpeg2video':
    case 'mpeg4':
    case 'libxvid':
    case 'msmpeg4':
    case 'msmpeg4v2':
    case 'wmv1':
    case 'wmv2':
    case 'mjpeg':
    case 'libtheora':
      args.push('-q:v', qualityToQV(crf), '-pix_fmt', 'yuv420p')
      break
    case 'prores':
    case 'prores_ks':
      args.push('-profile:v', '3', '-q:v', String(Math.max(1, Math.min(12, Math.round((crf - 18) / 2)))))
      break
    case 'dnxhd':
      args.push('-b:v', '50M', '-pix_fmt', 'yuv422p')
      break
    default:
      if (adv?.videoBitrate) args.push('-b:v', `${adv.videoBitrate}k`)
      else args.push('-crf', String(crf), '-pix_fmt', 'yuv420p')
  }
  const filters: string[] = []
  if (adv?.resolution && adv.resolution > 0) filters.push(`scale=-2:${adv.resolution}`)
  if (adv?.fps && adv.fps > 0) filters.push(`fps=${adv.fps}`)
  if (filters.length > 0) args.push('-vf', filters.join(','))
  return args
}

function audioEncodeArgs(encoder: string, targetId: string, adv?: AdvancedOptions): string[] {
  if (targetId === 'amr') return ['-c:a', 'libopencore_amrnb', '-ar', '8000', '-ac', '1']
  // Sun AU muxer accepts big-endian PCM only (verified against the bundled build).
  if (targetId === 'au') return ['-c:a', 'pcm_s16be']
  const lossless = encoder === 'flac' || encoder === 'alac' || encoder.startsWith('pcm_')
  const args = ['-c:a', encoder]
  if (!lossless) args.push('-b:a', `${adv?.audioBitrate ?? 192}k`)
  if (adv?.sampleRate && adv.sampleRate > 0) args.push('-ar', String(adv.sampleRate))
  if (adv?.channels && adv.channels > 0) args.push('-ac', String(adv.channels))
  return args
}

function imageEncodeArgs(targetId: string, adv?: AdvancedOptions): string[] {
  switch (targetId) {
    case 'jpg':
      return ['-c:v', 'mjpeg', '-q:v', qualityToQV(adv?.crf)]
    case 'png':
      return ['-c:v', 'png']
    case 'webp':
      return ['-c:v', 'libwebp', '-q:v', String(Math.min(100, Math.max(1, adv?.crf ?? 80)))]
    case 'gif':
      return ['-c:v', 'gif']
    case 'bmp':
      return ['-c:v', 'bmp']
    case 'tiff':
      return ['-c:v', 'tiff']
    case 'ico':
      return ['-c:v', 'png']
    case 'avif':
      return ['-c:v', 'libaom-av1', '-crf', '40', '-cpu-used', '8']
    default:
      return []
  }
}

function fastStartMuxer(targetId: string): boolean {
  const f = getFormat(targetId)
  return !!f && ['mp4', 'mov', 'm4v', 'ipod'].includes(f.muxer)
}

interface BuiltArgs {
  args: string[]
  stage: string
  needsEncode: boolean
}

export class ConverterManager {
  private jobs: ConverterJob[] = []
  private signals = new Map<string, { aborted: boolean }>()
  /** Per-job advanced FFmpeg overrides (kept private, never leaked to the UI). */
  private advanced = new Map<string, AdvancedOptions | undefined>()
  private detector: FileDetector
  private thumbnails: ThumbnailService
  private pdf: PdfConverter
  private pdfText: PdfTextConverter

  constructor(
    private settings: SettingsManager,
    private ffmpeg: FfmpegManager,
    private completed: CompletedManager,
    private history: HistoryManager
  ) {
    this.detector = new FileDetector(ffmpeg)
    this.thumbnails = new ThumbnailService(ffmpeg)
    this.pdf = new PdfConverter()
    this.pdfText = new PdfTextConverter()
  }

  getJobs(): ConverterJob[] {
    return this.jobs.map((j) => ({ ...j, progress: { ...j.progress } }))
  }

  async detectMany(paths: string[], onProgress?: (done: number, total: number) => void): Promise<DetectedFile[]> {
    return this.detector.detectMany(paths, onProgress)
  }

  /** Local preview URL (file://) for a file card thumbnail, or null. */
  getThumbnail(path: string): Promise<string | null> {
    return this.thumbnails.get(path)
  }

  get concurrency(): number {
    return Math.max(1, this.settings.get().maxConcurrentProcessing)
  }

  addRequest(req: ConversionRequest): { ok: boolean; error?: string; added?: number; unavailable?: number } {
    const items = Array.isArray(req.items) && req.items.length > 0
      ? req.items.filter((i) => i && typeof i.path === 'string' && typeof i.targetId === 'string')
      : Array.isArray(req.paths) && req.paths.length > 0 && typeof req.targetId === 'string'
        ? req.paths.map((path) => ({ path, targetId: req.targetId as string }))
        : []
    if (items.length === 0) return { ok: false, error: 'No files selected.' }
    return this.addRequests(items)
  }

  /**
   * Queue one or more conversions in a single IPC round-trip. Every file is
   * validated against its own output target, so a mixed batch (video + audio +
   * image + PDF) can be queued at once. Unsupported files are counted, not queued.
   */
  addRequests(items: { path: string; targetId: string; advanced?: AdvancedOptions }[]): { ok: boolean; error?: string; added?: number; unavailable?: number } {
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'No files selected.' }

    let added = 0
    let unavailable = 0
    for (const { path, targetId, advanced } of items) {
      if (typeof path !== 'string' || path.length === 0 || !existsSync(path)) continue
      const target = getConverterTarget(targetId)
      if (!target) continue
      const ext = extname(path).slice(1).toLowerCase()
      const name = basename(path)

      const job: ConverterJob = {
        id: randomUUID(),
        inputPath: path,
        inputName: name,
        inputCategory: 'unsupported',
        targetId: target.id,
        targetLabel: target.label,
        targetExtension: target.extension,
        state: 'Waiting',
        progress: { percent: 0, stage: STAGE_PREPARE, message: 'queued' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 1
      }
      this.advanced.set(job.id, advanced && Object.keys(advanced).length > 0 ? advanced : undefined)
      // Backend is authoritative: a target is only valid for this file's real category.
      const cat = extensionCategory(ext)
      job.inputCategory = cat
      let failed: string | null = null
      if (cat === 'unsupported') {
        failed = 'This file type is not supported for conversion.'
      } else if (cat === 'image' && target.kind !== 'image') {
        failed = `Images can only be converted to image formats, not ${target.label}.`
      } else if (cat === 'pdf' && !isPdfTarget(target.id)) {
        failed = `PDF files can only be converted to supported image or document formats, not ${target.label}.`
      } else if (cat !== 'image' && cat !== 'pdf' && target.kind === 'image') {
        failed = `Video/audio files cannot be converted to ${target.label}.`
      } else if (cat === 'audio' && target.kind === 'video') {
        failed = 'Audio files cannot be converted to video formats.'
      }
      if (failed) {
        job.state = 'Failed'
        job.error = failed
        unavailable += 1
      }
      this.jobs.unshift(job)
      added += 1
    }

    if (added === 0) return { ok: false, error: 'None of the selected files could be queued.', added: 0, unavailable }
    this.emit()
    this.schedule()
    return { ok: true, added, unavailable }
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    const sig = this.signals.get(id)
    if (job.state === 'Waiting') {
      job.state = 'Cancelled'
      job.progress = { percent: 0, stage: STAGE_PREPARE, message: 'cancelled' }
      job.updatedAt = Date.now()
    } else if ((job.state === 'Converting' || job.state === 'Processing') && sig) {
      sig.aborted = true
      job.state = 'Cancelled'
      job.updatedAt = Date.now()
    }
    this.emit()
    this.schedule()
  }

  retry(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || (job.state !== 'Failed' && job.state !== 'Cancelled')) return
    job.state = 'Waiting'
    job.error = undefined
    job.errorDetails = undefined
    job.outputPath = undefined
    job.outputName = undefined
    job.attempt += 1
    job.progress = { percent: 0, stage: STAGE_PREPARE, message: 'queued' }
    job.updatedAt = Date.now()
    this.emit()
    this.schedule()
  }

  clearFinished(): void {
    const removed = this.jobs.filter((j) => j.state === 'Waiting' || j.state === 'Converting' || j.state === 'Processing')
    this.jobs = removed
    for (const j of removed) this.advanced.delete(j.id)
    this.emit()
  }

  clearAll(): void {
    for (const j of this.jobs) {
      if (j.state === 'Converting' || j.state === 'Processing') {
        const sig = this.signals.get(j.id)
        if (sig) sig.aborted = true
      }
    }
    this.jobs = []
    this.advanced.clear()
    this.emit()
  }

  private schedule(): void {
    const max = this.concurrency
    const active = this.jobs.filter((j) => j.state === 'Converting' || j.state === 'Processing').length
    const slots = Math.max(0, max - active)
    if (slots === 0) return
    const cfg = this.settings.get()
    const waiting = this.jobs.filter((j) => j.state === 'Waiting').slice(0, slots)
    for (const job of waiting) {
      void this.runJob(job, cfg)
    }
  }

  private async runJob(job: ConverterJob, cfg: AppSettings): Promise<void> {
    const sig = { aborted: false }
    this.signals.set(job.id, sig)
    try {
      job.state = 'Converting'
      job.progress = { percent: 0, stage: STAGE_PREPARE, message: 'starting' }
      job.updatedAt = Date.now()
      this.emit()

      // PDFs bypass FFmpeg entirely (the bundled build cannot read them) and
      // go through the bundled pdfjs + @napi-rs/canvas rendering pipeline.
      if (job.inputCategory === 'pdf') {
        await this.runPdfJob(job, cfg, sig)
        return
      }

      // Probe the real content up-front (codecs, duration) for copy/encode planning.
      const probe = await this.ffmpeg.probe(job.inputPath)
      if (sig.aborted) {
        this.finishCancelled(job)
        return
      }

      // Resolve the destination honoring the on-existing-file policy BEFORE work.
      const outDir = (cfg.converterOutputFolder && cfg.converterOutputFolder.trim()) || cfg.downloadFolder
      const baseName = sanitizeFilename(parsePath(job.inputName).name, 'converted')
      const res = resolveFinalPath(outDir, `${baseName}.${job.targetExtension}`, { action: cfg.onExistingFile }, cfg.sanitizeFilenames)
      if (res.action === 'skip') {
        job.state = 'Failed'
        job.error = 'Output file already exists and the "Skip" policy is active.'
        job.errorDetails = res.path
        job.progress = { percent: 0, stage: STAGE_PREPARE, message: 'exists' }
        job.updatedAt = Date.now()
        this.emit()
        return
      }
      const outPath = res.path
      job.outputPath = outPath
      job.outputName = basename(outPath)

      const built = this.buildArgs(job, probe, outPath)
      job.progress = { percent: 0, indeterminate: !built.needsEncode && job.inputCategory === 'image', stage: built.stage, message: built.stage }
      job.updatedAt = Date.now()
      this.emit()

      const result = await this.ffmpeg.run(built.args, {
        onProgress: (line) => {
          if (sig.aborted || job.state !== 'Converting') return
          const t = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
          let percent: number | null = null
          if (t) {
            const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])
            if (probe.duration && probe.duration > 0) {
              percent = Math.min(99, (secs / probe.duration) * 100)
            }
          }
          job.progress = {
            percent: percent ?? job.progress.percent,
            indeterminate: percent === null && job.inputCategory === 'image',
            stage: built.stage,
            message: built.stage
          }
          job.updatedAt = Date.now()
          this.emitProgress(job)
        },
        signal: sig
      })

      if (sig.aborted) {
        this.cleanupOutput(outPath)
        this.finishCancelled(job)
        return
      }
      if (result.code !== 0) {
        this.cleanupOutput(outPath)
        job.state = 'Failed'
        job.error = `Conversion failed (FFmpeg exit code ${result.code}).`
        job.errorDetails = this.summarizeError(result.stderr)
        job.progress = { percent: 0, stage: built.stage, message: 'failed' }
        job.updatedAt = Date.now()
        this.emit()
        logger.error(`[VIDAUD][CONVERTER] ffmpeg failed for ${job.inputName}: ${result.stderr.slice(-800)}`)
        return
      }

      // Validation: open/play the produced file before declaring success.
      job.state = 'Processing'
      job.progress = { percent: 100, stage: STAGE_VALIDATE, message: 'validating' }
      job.updatedAt = Date.now()
      this.emit()
      const ok = await this.ffmpeg.validate(outPath)
      if (sig.aborted) {
        this.cleanupOutput(outPath)
        this.finishCancelled(job)
        return
      }
      if (!ok || !existsSync(outPath) || fileSizeBytes(outPath) <= 0) {
        this.cleanupOutput(outPath)
        job.state = 'Failed'
        job.error = 'Validation failed: the produced file could not be read back.'
        job.progress = { percent: 100, stage: STAGE_VALIDATE, message: 'failed' }
        job.updatedAt = Date.now()
        this.emit()
        return
      }

      job.state = 'Completed'
      job.progress = { percent: 100, stage: STAGE_VALIDATE, message: 'done' }
      job.updatedAt = Date.now()
      this.registerOutput(job)
      this.emit()
      logger.info(`[VIDAUD][CONVERTER] ${job.inputName} -> ${job.outputName} OK`)
    } catch (e) {
      if (sig.aborted) {
        this.finishCancelled(job)
        return
      }
      job.state = 'Failed'
      job.error = e instanceof Error ? e.message : 'Conversion failed.'
      job.progress = { percent: 0, stage: STAGE_PREPARE, message: 'failed' }
      job.updatedAt = Date.now()
      if (job.outputPath) this.cleanupOutput(job.outputPath)
      this.emit()
      logger.error(`[VIDAUD][CONVERTER] ${job.inputName} threw: ${e}`)
    } finally {
      this.signals.delete(job.id)
      this.schedule()
    }
  }

  /**
   * PDF conversion: handles both image extraction (PNG, JPG, WEBP, TIFF, BMP)
   * into an organized folder, and document generation (DOCX, TXT, HTML, RTF, MD)
   * into a single output file.
   */
  private async runPdfJob(job: ConverterJob, cfg: AppSettings, sig: { aborted: boolean }): Promise<void> {
    const outDir = (cfg.converterOutputFolder && cfg.converterOutputFolder.trim()) || cfg.downloadFolder
    const baseName = sanitizeFilename(parsePath(job.inputName).name, 'converted')
    const adv = this.advanced.get(job.id)

    if (isPdfDocTarget(job.targetId)) {
      // Document output: single file e.g. "My Document.docx" or "My Document.txt"
      const res = resolveFinalPath(outDir, `${baseName}.${job.targetExtension}`, { action: cfg.onExistingFile }, cfg.sanitizeFilenames)
      if (res.action === 'skip') {
        job.state = 'Failed'
        job.error = 'Output file already exists and the "Skip" policy is active.'
        job.errorDetails = res.path
        job.progress = { percent: 0, stage: STAGE_EXTRACT, message: 'exists' }
        job.updatedAt = Date.now()
        this.emit()
        return
      }

      const outFilePath = res.path
      job.outputPath = outFilePath
      job.outputName = basename(outFilePath)
      job.progress = { percent: 0, indeterminate: true, stage: STAGE_EXTRACT, message: 'extracting' }
      job.updatedAt = Date.now()
      this.emit()

      try {
        const result = await this.pdfText.convert(job.inputPath, outFilePath, job.targetId as PdfDocOutputFormat, {
          signal: sig,
          password: adv?.pdfPassword,
          onProgress: (page, total, message) => {
            if (sig.aborted || job.state !== 'Converting') return
            job.progress = {
              percent: Math.min(99, Math.round((page / total) * 100)),
              stage: STAGE_EXTRACT,
              message: message || `Extracting page ${page} of ${total}`
            }
            job.updatedAt = Date.now()
            this.emitProgress(job)
          }
        })

        if (sig.aborted) {
          this.cleanupOutput(outFilePath)
          this.finishCancelled(job)
          return
        }

        // Validation
        job.state = 'Processing'
        job.progress = { percent: 100, stage: STAGE_VALIDATE, message: 'validating' }
        job.updatedAt = Date.now()
        this.emit()

        if (!existsSync(outFilePath) || fileSizeBytes(outFilePath) <= 0) {
          this.cleanupOutput(outFilePath)
          job.state = 'Failed'
          job.error = 'Validation failed: output document could not be generated.'
          job.progress = { percent: 100, stage: STAGE_VALIDATE, message: 'failed' }
          job.updatedAt = Date.now()
          this.emit()
          return
        }

        job.state = 'Completed'
        job.pageCount = result.pageCount
        job.progress = { percent: 100, stage: STAGE_VALIDATE, message: 'done' }
        job.updatedAt = Date.now()
        this.registerOutput(job)
        this.emit()
        logger.info(`[VIDAUD][CONVERTER] ${job.inputName} -> ${job.outputName} (${result.pageCount} pages, doc) OK`)
      } catch (err: unknown) {
        if (sig.aborted) {
          this.cleanupOutput(outFilePath)
          this.finishCancelled(job)
          return
        }
        this.cleanupOutput(outFilePath)
        job.state = 'Failed'
        job.error = err instanceof Error ? err.message : 'PDF document conversion failed.'
        job.progress = { percent: 0, stage: STAGE_EXTRACT, message: 'failed' }
        job.updatedAt = Date.now()
        this.emit()
      }
      return
    }

    // Image output: each page becomes an image in a dedicated subfolder
    const folderName = sanitizeFilename(`${baseName}-${job.targetExtension}`, 'converted')
    const res = resolveFinalPath(outDir, folderName, { action: cfg.onExistingFile }, cfg.sanitizeFilenames)
    if (res.action === 'skip') {
      job.state = 'Failed'
      job.error = 'Output folder already exists and the "Skip" policy is active.'
      job.errorDetails = res.path
      job.progress = { percent: 0, stage: STAGE_IMAGE, message: 'exists' }
      job.updatedAt = Date.now()
      this.emit()
      return
    }
    const outDirPath = res.path
    if (res.action === 'replace' && existsSync(outDirPath)) this.cleanupOutput(outDirPath)
    mkdirSync(outDirPath, { recursive: true })
    job.outputPath = outDirPath
    job.outputName = basename(outDirPath)

    job.progress = { percent: 0, indeterminate: true, stage: STAGE_IMAGE, message: 'rendering' }
    job.updatedAt = Date.now()
    this.emit()

    try {
      const result = await this.pdf.convert(job.inputPath, outDirPath, job.targetId as PdfImageOutputFormat, {
        baseName: pdfPagePrefix(job.inputName),
        quality: adv?.pdfQuality || adv?.crf || 90,
        dpi: adv?.pdfDpi || 150,
        pageRangeMode: adv?.pdfPageRangeMode,
        pageRangeStart: adv?.pdfPageRangeStart,
        pageRangeEnd: adv?.pdfPageRangeEnd,
        password: adv?.pdfPassword,
        signal: sig,
        onPage: (page, total, message) => {
          if (sig.aborted || job.state !== 'Converting') return
          job.progress = {
            percent: Math.min(99, Math.round(((page - 1) / total) * 100)),
            stage: STAGE_IMAGE,
            message: message || `Rendering page ${page} of ${total}`
          }
          job.updatedAt = Date.now()
          this.emitProgress(job)
        }
      })

      if (sig.aborted) {
        this.cleanupOutput(outDirPath)
        this.finishCancelled(job)
        return
      }

      // Validation: every produced page must exist and be non-empty.
      job.state = 'Processing'
      job.progress = { percent: 100, stage: STAGE_VALIDATE, message: 'validating' }
      job.updatedAt = Date.now()
      this.emit()
      const allOk = result.outputPaths.length > 0 && result.outputPaths.every((p) => existsSync(p) && fileSizeBytes(p) > 0)
      if (!allOk) {
        this.cleanupOutput(outDirPath)
        job.state = 'Failed'
        job.error = 'Validation failed: the produced page images could not be read back.'
        job.progress = { percent: 100, stage: STAGE_VALIDATE, message: 'failed' }
        job.updatedAt = Date.now()
        this.emit()
        return
      }

      job.state = 'Completed'
      job.pageCount = result.renderedCount
      job.progress = { percent: 100, stage: STAGE_VALIDATE, message: 'done' }
      job.updatedAt = Date.now()
      this.registerOutput(job)
      this.emit()
      logger.info(`[VIDAUD][CONVERTER] ${job.inputName} -> ${job.outputName} (${result.renderedCount} pages) OK`)
    } catch (err: unknown) {
      if (sig.aborted) {
        this.cleanupOutput(outDirPath)
        this.finishCancelled(job)
        return
      }
      this.cleanupOutput(outDirPath)
      job.state = 'Failed'
      job.error = err instanceof Error ? err.message : 'PDF image conversion failed.'
      job.progress = { percent: 0, stage: STAGE_IMAGE, message: 'failed' }
      job.updatedAt = Date.now()
      this.emit()
    }
  }

  private buildArgs(job: ConverterJob, probe: { hasVideo: boolean; hasAudio: boolean; videoCodec?: string; audioCodec?: string }, outPath: string): BuiltArgs {    const target = getConverterTarget(job.targetId)
    if (!target) throw new Error('Unknown output format.')
    const fmt = getFormat(job.targetId)
    const adv = this.advanced.get(job.id)

    if (job.inputCategory === 'image') {
      return {
        args: ['-y', '-i', job.inputPath, '-map', '0:v:0', '-frames:v', '1', ...imageEncodeArgs(job.targetId, adv), outPath],
        stage: STAGE_IMAGE,
        needsEncode: true
      }
    }

    if (job.inputCategory === 'audio') {
      return this.buildAudioArgs(job, target, probe, fmt, outPath, adv)
    }

    // video input
    if (target.kind === 'video' && fmt) {
      // Explicit advanced settings force a full re-encode so every option applies.
      if (hasAdvanced(adv)) return this.buildVideoAdvanced(job, fmt, adv!, outPath)
      const videoCodec = normalizeCodec(probe.videoCodec)
      const audioCodec = normalizeCodec(probe.audioCodec)
      const copyVideo = !!videoCodec && fmt.videoCodecs.includes(videoCodec)
      const copyAudio = !probe.hasAudio || (!!audioCodec && fmt.audioCodecs.includes(audioCodec))
      const args = ['-y', '-i', job.inputPath, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-max_muxing_queue_size', '1024']
      if (copyVideo) args.push('-c:v', 'copy')
      else args.push(...videoEncodeArgs(fmt.defaultVideoCodec ?? 'libx264'))
      if (copyAudio) args.push('-c:a', 'copy')
      else {
        args.push(...audioEncodeArgs(fmt.defaultAudioCodec ?? 'aac', job.targetId))
        if (job.targetId === 'mxf') args.push('-ar', '48000')
      }
      if (fastStartMuxer(job.targetId)) args.push('-movflags', '+faststart')
      args.push(outPath)
      return { args, stage: STAGE_CONVERT, needsEncode: !copyVideo || !copyAudio }
    }

    if (target.kind === 'audio') {
      return this.buildAudioArgs(job, target, probe, fmt, outPath, adv)
    }

    throw new Error(`No conversion path from ${job.inputCategory} to ${job.targetLabel}.`)
  }

  private buildVideoAdvanced(job: ConverterJob, fmt: FormatDefinition, adv: AdvancedOptions, outPath: string): BuiltArgs {
    const vcodec = normalizeCodec(adv.videoCodec) || fmt.defaultVideoCodec || 'libx264'
    const acodec = normalizeCodec(adv.audioCodec) || fmt.defaultAudioCodec || 'aac'
    const args = ['-y', '-i', job.inputPath, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-max_muxing_queue_size', '1024']
    args.push(...videoEncodeArgs(vcodec, adv))
    args.push(...audioEncodeArgs(acodec, job.targetId, adv))
    if (fastStartMuxer(job.targetId)) args.push('-movflags', '+faststart')
    args.push(outPath)
    return { args, stage: STAGE_CONVERT, needsEncode: true }
  }

  private buildAudioArgs(
    job: ConverterJob,
    target: { id: string; defaultAudioCodec?: string },
    probe: { hasAudio: boolean; audioCodec?: string },
    fmt: FormatDefinition | undefined,
    outPath: string,
    adv?: AdvancedOptions
  ): BuiltArgs {
    if (!probe.hasAudio) throw new Error('This file has no audio stream to extract.')
    const args = ['-y', '-i', job.inputPath, '-vn', '-map', '0:a:0?', '-max_muxing_queue_size', '1024']
    if (hasAdvanced(adv)) {
      const encoder = normalizeCodec(adv!.audioCodec) || fmt?.defaultAudioCodec || 'aac'
      args.push(...audioEncodeArgs(encoder, target.id, adv))
      if (job.targetId === 'mxf') args.push('-ar', '48000')
    } else {
      const audioCodec = normalizeCodec(probe.audioCodec)
      const copyAudio = !!audioCodec && !!fmt && fmt.audioCodecs.includes(audioCodec)
      const encoder = fmt?.defaultAudioCodec ?? 'aac'
      if (copyAudio) args.push('-c:a', 'copy')
      else args.push(...audioEncodeArgs(encoder, target.id))
      if (job.targetId === 'mxf') args.push('-ar', '48000')
    }
    if (fastStartMuxer(job.targetId)) args.push('-movflags', '+faststart')
    args.push(outPath)
    return { args, stage: STAGE_EXTRACT, needsEncode: true }
  }

  private registerOutput(job: ConverterJob): void {
    if (!job.outputPath || !job.outputName) return
    const size = this.outputSize(job.outputPath)
    const type: 'video' | 'audio' | 'image' =
      job.inputCategory === 'image' || job.inputCategory === 'pdf'
        ? 'image'
        : getFormat(job.targetId)?.kind === 'audio'
          ? 'audio'
          : 'video'
    const ext = extname(job.inputPath).slice(1).toLowerCase()
    this.completed.add({
      title: job.outputName,
      filePath: job.outputPath,
      fileName: job.outputName,
      format: job.targetLabel,
      type,
      size,
      source: 'converter',
      originalFormat: ext || undefined
    })
    this.history.add({
      fileName: job.outputName,
      type,
      size,
      status: 'completed',
      path: job.outputPath,
      url: '',
      source: 'converter'
    })
  }

  /** Total bytes of the output. For PDF page folders this sums every page image. */
  private outputSize(outPath: string): number {
    try {
      const st = statSync(outPath)
      if (!st.isDirectory()) return st.size
      let total = 0
      for (const n of readdirSync(outPath)) {
        try {
          total += statSync(join(outPath, n)).size
        } catch {
          /* ignore unreadable entries */
        }
      }
      return total
    } catch {
      return 0
    }
  }

  private finishCancelled(job: ConverterJob): void {
    job.state = 'Cancelled'
    job.progress = { percent: 0, stage: STAGE_PREPARE, message: 'cancelled' }
    job.updatedAt = Date.now()
    this.emit()
  }

  private cleanupOutput(outPath?: string): void {
    if (!outPath) return
    try {
      if (existsSync(outPath)) rmSync(outPath, { force: true, recursive: true })
    } catch (e) {
      logger.warn(`[VIDAUD][CONVERTER] cleanup failed for ${outPath}: ${e}`)
    }
  }

  private summarizeError(stderr: string): string {
    const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    const err = lines.filter((l) => /error|invalid|failed|cannot|could not|unsupported|unable/i.test(l))
    const pick = err.length > 0 ? err : lines.slice(-3)
    return pick.slice(-2).join(' | ').slice(0, 300)
  }

  private emit(): void {
    const snapshot = this.getJobs()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.events.converterJobs, snapshot)
    }
  }

  private emitProgress(job: ConverterJob): void {
    const payload: ConverterProgressPayload = {
      id: job.id,
      percent: job.progress.indeterminate ? null : job.progress.percent,
      stage: job.progress.stage
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.events.converterProgress, payload)
    }
  }
}
