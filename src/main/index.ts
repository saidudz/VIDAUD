import { app, BrowserWindow, shell, screen, powerMonitor, Menu, clipboard, nativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createCanvas } from '@napi-rs/canvas'
import { logger } from './utils/logger'
import { SettingsManager } from './settings/SettingsManager'
import { HistoryManager } from './history/HistoryManager'
import { CompletedManager } from './completed/CompletedManager'
import { NotificationManager } from './notification/NotificationManager'
import { QueueManager } from './queue/QueueManager'
import { PlaylistManager } from './playlist/PlaylistManager'
import { WindowController } from './window/WindowController'
import { WindowStateManager } from './window/WindowStateManager'
import { ConverterManager } from './converter/ConverterManager'
import { FfmpegManager } from './ffmpeg/FfmpegManager'
import { registerIpc } from './ipc'
import { loadAnalyzeCache, analyzeWithCache } from './analyzer/AnalyzerManager'
import { IPC } from '@shared/types'
import type { DownloadTask, TaskState, CompletedItem } from '@shared/types'
import { calculateStatistics } from '@shared/statistics'

// Smoke tests MUST run against an isolated userData directory so they can
// never read, modify, or wipe the real queue/history/completed/settings data.
// This must happen BEFORE requestSingleInstanceLock() so the smoke instance
// also gets its own lock and can run alongside the real app.
const isSmoke = process.env['VIDAUD_SMOKE_WINDOW'] === '1' || process.env['VIDAUD_SMOKE_HISTORY'] === '1' || process.env['VIDAUD_SMOKE_CLEAR'] === '1' || process.env['VIDAUD_SMOKE_CONVERTER'] === '1' || process.env['VIDAUD_SMOKE_COMPLETED'] === '1' || process.env['VIDAUD_SMOKE_PAUSE'] === '1' || process.env['VIDAUD_SMOKE_CLIPBOARD'] === '1' || process.env['VIDAUD_SMOKE_CLASSIFY'] === '1' || !!process.env['VIDAUD_SMOKE_URL']
if (isSmoke) {
  app.setPath('userData', join(app.getPath('temp'), 'vidaud-smoke-data'))
}

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let windowController: WindowController | null = null
let windowState: WindowStateManager

async function maybeRunSmoke(queue: QueueManager, settings: SettingsManager): Promise<void> {
  const url = process.env['VIDAUD_SMOKE_URL']
  if (!url) return
  const kind = (process.env['VIDAUD_SMOKE_KIND'] ?? 'video') as 'video' | 'audio'
  const quality = process.env['VIDAUD_SMOKE_QUALITY'] ?? (kind === 'video' ? '360' : '128')
  const format = process.env['VIDAUD_SMOKE_FORMAT'] ?? (kind === 'video' ? 'mp4' : 'mp3')
  const folder = process.env['VIDAUD_SMOKE_FOLDER']
  const opts = settings.get()
  if (folder) settings.save({ ...opts, downloadFolder: folder, notifications: false })
  else settings.save({ ...opts, notifications: false })

  logger.info(`[smoke] starting end-to-end download of ${url} (${kind}/${format}/${quality})`)
  const res = queue.addRequest({
    url,
    kind,
    format,
    quality,
    title: 'smoke-test'
  })
  const taskId = res.taskIds[0]
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const task = queue.getQueue().find((t) => t.id === taskId)
    if (task && task.state === 'Completed') {
      // Completed standalone jobs now stay in the Downloads queue until the
      // user presses Clear Completed; the file is also registered in the
      // persistent Completed library.
      const done = queue.getCompletedItems().some((c) => c.uniqueKey === task.uniqueKey)
      logger.info(`[smoke] task reached Completed: ${done ? 'OK' : 'missing from Completed library'}`)
      setTimeout(() => app.exit(done ? 0 : 1), 500)
      return
    }
    if (!task || task.state === 'Failed' || task.state === 'Cancelled') {
      logger.info(`[smoke] final state=${task?.state ?? 'gone-from-queue'} error=${task?.error ?? ''}`)
      setTimeout(() => app.exit(1), 500)
      return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  logger.info('[smoke] timed out waiting for download')
  app.exit(2)
}

/**
 * End-to-end History + Navigation smoke test, driven by env vars:
 *   VIDAUD_SMOKE_HISTORY=1            enable the test
 *   VIDAUD_SMOKE_HISTORY_OUT=<path>    JSON report destination (default: temp)
 * Exercises the real renderer through IPC: add entry -> navigate to History ->
 * verify header + table -> Clear History -> verify storage=0, UI=0 ->
 * leave/return to History -> still empty. Exits 0 on pass, 1 on failure.
 */
async function maybeRunHistorySmoke(win: BrowserWindow, settings: SettingsManager): Promise<void> {
  if (process.env['VIDAUD_SMOKE_HISTORY'] !== '1') return
  settings.save({ ...settings.get(), language: 'en', notifications: false })

  const wc = win.webContents
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const report: Record<string, unknown> = {}
  const failures: string[] = []
  const fail = (msg: string): void => {
    failures.push(msg)
  }

  try {
    await new Promise<void>((resolve) => {
      if (!wc.isLoading()) resolve()
      else wc.once('did-finish-load', () => resolve())
    })
    await delay(1800)

    const cleared = (await wc.executeJavaScript('window.vidaud.clearHistory()')) as { success?: boolean }
    if (!cleared?.success) fail('clearHistory() did not report success')

    await wc.executeJavaScript(
      `window.vidaud.addHistoryItem({ fileName: 'smoke-test.mp4', date: Date.now(), type: 'video', size: 1234, status: 'Completed', path: 'C:\\\\Users\\\\smoke\\\\smoke-test.mp4', url: 'https://example.com/video' })`
    )
    await delay(400)

    const storageAfterAdd = (await wc.executeJavaScript('window.vidaud.getHistory()')) as unknown[]
    report.storageAfterAdd = storageAfterAdd.length
    if (storageAfterAdd.length !== 1) fail(`expected 1 item in storage after add, got ${storageAfterAdd.length}`)

    const navCount = (await wc.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll('.nav-item')); b[3].click(); return b.length })()`)) as number
    if (navCount !== 7) fail(`expected 7 nav items, got ${navCount}`)
    await delay(450)

    const header = (await wc.executeJavaScript(`document.querySelector('.topbar h1')?.textContent ?? ''`)) as string
    report.headerAfterNav = header
    if (!String(header).toLowerCase().includes('history')) fail(`header should read History, got '${header}'`)

    const rowsAfterAdd = (await wc.executeJavaScript(`document.querySelectorAll('.table tbody tr').length`)) as number
    report.uiRowsAfterAdd = rowsAfterAdd
    if (rowsAfterAdd !== 1) fail(`expected 1 row in History table, got ${rowsAfterAdd}`)

    const clickedClear = (await wc.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll('.btn-danger')); if (b.length > 0) { b[b.length - 1].click(); return true } return false })()`)) as boolean
    if (!clickedClear) fail('Clear History button not found')
    await delay(250)
    const clickedYes = (await wc.executeJavaScript(`(() => { const y = document.querySelector('.confirm-actions .btn'); if (y) { y.click(); return true } return false })()`)) as boolean
    if (!clickedYes) fail('Confirm dialog Yes button not found')
    await delay(600)

    const storageAfterClear = (await wc.executeJavaScript('window.vidaud.getHistory()')) as unknown[]
    report.storageAfterClear = storageAfterClear.length
    if (storageAfterClear.length !== 0) fail(`storage not empty after clear, got ${storageAfterClear.length}`)

    const emptyAfterClear = (await wc.executeJavaScript(`document.body.textContent.includes('No download history yet.')`)) as boolean
    report.uiEmptyAfterClear = emptyAfterClear
    if (!emptyAfterClear) fail('empty state not shown after clear')

    await wc.executeJavaScript(`document.querySelectorAll('.nav-item')[0].click()`)
    await delay(250)
    await wc.executeJavaScript(`document.querySelectorAll('.nav-item')[3].click()`)
    await delay(450)

    const emptyAfterReturn = (await wc.executeJavaScript(`document.body.textContent.includes('No download history yet.')`)) as boolean
    const headerAfterReturn = (await wc.executeJavaScript(`document.querySelector('.topbar h1')?.textContent ?? ''`)) as string
    report.uiEmptyAfterReturn = emptyAfterReturn
    report.headerAfterReturn = headerAfterReturn
    if (!emptyAfterReturn) fail('empty state not preserved after leave/return')
    if (!String(headerAfterReturn).toLowerCase().includes('history')) fail(`header should read History after return, got '${headerAfterReturn}'`)
  } catch (e) {
    fail(`smoke crashed: ${String(e)}`)
  }

  report.pass = failures.length === 0
  report.failures = failures
  const out = process.env['VIDAUD_SMOKE_HISTORY_OUT'] ?? join(app.getPath('temp'), 'vidaud-history-smoke.json')
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
  logger.info(`[smoke][history] report written to ${out} -> ${report.pass ? 'PASS' : 'FAIL'}`)
  app.exit(report.pass ? 0 : 1)
}

/**
 * End-to-end Clear Completed smoke test, driven by env vars:
 *   VIDAUD_SMOKE_CLEAR=1            enable the test
 *   VIDAUD_SMOKE_CLEAR_OUT=<path>   JSON report destination (default: temp)
 * Seeds the live queue with Completed / Failed / Waiting / Downloading tasks,
 * then drives the real IPC path the UI uses (`window.vidaud.clearCompleted()`).
 * Verifies only Completed tasks leave the queue, the rest are untouched, the
 * result is persisted, and History + Completed library are not modified.
 * Exits 0 on pass, 1 on failure.
 */
async function maybeRunClearCompletedSmoke(win: BrowserWindow, queue: QueueManager): Promise<void> {
  if (process.env['VIDAUD_SMOKE_CLEAR'] !== '1') return

  const wc = win.webContents
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const report: Record<string, unknown> = {}
  const failures: string[] = []
  const fail = (msg: string): void => {
    failures.push(msg)
  }

  const seed = (id: string, state: TaskState): void => {
    const q = queue as unknown as { tasks: DownloadTask[] }
    q.tasks.push({
      id,
      uniqueKey: `smoke-${id}`,
      title: `smoke-${id}`,
      url: `https://example.com/${id}.mp4`,
      kind: 'video',
      format: 'mp4',
      quality: '360',
      state,
      progress: { percent: state === 'Downloading' ? 50 : 0, downloadedBytes: 0, stage: 'queued' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempt: 0,
      tempDir: join(app.getPath('temp'), 'vidaud', `task-${id}`)
    })
  }

  try {
    await new Promise<void>((resolve) => {
      if (!wc.isLoading()) resolve()
      else wc.once('did-finish-load', () => resolve())
    })
    await delay(1200)

    // Deterministic start: clear the in-memory queue (and its maps) plus the
    // persisted file, and wipe history, so leftover state from earlier smoke
    // runs can never pollute the assertions. Completed library is left intact
    // and asserted to be unchanged.
    const internals = queue as unknown as {
      tasks: DownloadTask[]
      jobsByKey: Map<string, DownloadTask>
      requests: Map<string, unknown>
      controls: Map<string, unknown>
      running: Set<string>
      persist: () => void
      persistFile: string
    }
    internals.tasks = []
    internals.jobsByKey.clear()
    internals.requests.clear()
    internals.controls.clear()
    internals.running.clear()
    internals.persist()
    await wc.executeJavaScript('window.vidaud.clearHistory()')
    await delay(200)

    const historyBefore = (await wc.executeJavaScript('window.vidaud.getHistory()')) as unknown[]
    report.historyBefore = historyBefore.length

    seed('a', 'Completed')
    seed('b', 'Completed')
    seed('c', 'Failed')
    seed('d', 'Waiting')
    seed('e', 'Downloading')

    report.seeded = queue.getQueue().map((t) => t.id)
    if (queue.getQueue().length !== 5) fail(`expected 5 seeded tasks, got ${queue.getQueue().length}`)

    const completedBefore = (await wc.executeJavaScript('window.vidaud.getCompleted()')) as unknown[]
    report.completedBefore = completedBefore.length
    if (completedBefore.length !== 0) {
      logger.info(`[smoke][clear] Completed library already has ${completedBefore.length} item(s) from prior smoke runs; asserting it is unchanged by Clear Completed`)
    }

    const res = (await wc.executeJavaScript('window.vidaud.clearCompleted()')) as { success?: boolean; count?: number; removedIds?: string[] }
    report.ipcResult = res
    if (!res?.success) fail('clearCompleted() did not report success')

    await delay(400)

    const remaining = queue.getQueue().map((t) => t.id)
    report.remaining = remaining
    if (remaining.includes('a') || remaining.includes('b')) fail('completed tasks still in queue')
    for (const keep of ['c', 'd', 'e']) {
      if (!remaining.includes(keep)) fail(`non-completed task ${keep} was removed`)
    }
    if ((res?.removedIds?.length ?? 0) !== 2) fail(`expected 2 removedIds, got ${res?.removedIds?.length}`)

    const historyCount = (await wc.executeJavaScript('window.vidaud.getHistory()')) as unknown[]
    report.historyCount = historyCount.length
    if (historyCount.length !== historyBefore.length) fail('history was modified by Clear Completed')

    const completedAfter = (await wc.executeJavaScript('window.vidaud.getCompleted()')) as unknown[]
    report.completedCount = completedAfter.length
    if (completedAfter.length !== completedBefore.length) fail('Completed library was modified by Clear Completed')

    // Persistence (spec #27): the persisted queue file must no longer contain
    // the cleared completed tasks and must still contain the surviving ones.
    const persisted = JSON.parse(readFileSync(internals.persistFile, 'utf-8')) as Array<{ id: string; state: string }>
    const persistedIds = (Array.isArray(persisted) ? persisted : []).map((p) => p.id)
    report.persisted = persistedIds
    if (persistedIds.includes('a') || persistedIds.includes('b')) fail('completed tasks still persisted in queue file')
    for (const keep of ['c', 'd', 'e']) {
      if (!persistedIds.includes(keep)) fail(`non-completed task ${keep} missing from persisted queue file`)
    }
  } catch (e) {
    fail(`smoke crashed: ${String(e)}`)
  }

  report.pass = failures.length === 0
  report.failures = failures
  const out = process.env['VIDAUD_SMOKE_CLEAR_OUT'] ?? join(app.getPath('temp'), 'vidaud-clear-smoke.json')
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
  logger.info(`[smoke][clear] report written to ${out} -> ${report.pass ? 'PASS' : 'FAIL'}`)
  app.exit(report.pass ? 0 : 1)
}

/**
 * End-to-end Delete All (Completed library) smoke test, driven by env vars:
 *   VIDAUD_SMOKE_COMPLETED=1            enable the test
 *   VIDAUD_SMOKE_COMPLETED_OUT=<path>   JSON report destination (default: temp)
 * Seeds real Completed records, then drives the REAL IPC path the UI uses
 * (`window.vidaud.confirmDeleteAllCompleted()`), which in smoke mode skips the
 * native confirm dialog. Asserts the records are removed from memory AND from
 * the persisted completed.json (so they stay gone after a restart), the UI was
 * refreshed via the completed event, an already-empty library is a no-op
 * success, and the real files on disk are never touched. Exits 0 on pass.
 */
async function maybeRunDeleteAllCompletedSmoke(win: BrowserWindow, completed: CompletedManager): Promise<void> {
  if (process.env['VIDAUD_SMOKE_COMPLETED'] !== '1') return

  const wc = win.webContents
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const report: Record<string, unknown> = {}
  const failures: string[] = []
  const fail = (msg: string): void => {
    failures.push(msg)
  }

  // Two scratch files that genuinely exist on disk, so the test can assert
  // Delete All is records-only and never touches the downloaded files.
  const scratchDir = join(app.getPath('temp'), 'vidaud-deleteall-smoke')
  if (!existsSync(scratchDir)) mkdirSync(scratchDir, { recursive: true })
  const scratchA = join(scratchDir, 'smoke-a.mp4')
  const scratchB = join(scratchDir, 'smoke-b.mp3')
  writeFileSync(scratchA, 'smoke')
  writeFileSync(scratchB, 'smoke')

  const internals = completed as unknown as { items: CompletedItem[]; file: string; persist: () => void }

  try {
    await new Promise<void>((resolve) => {
      if (!wc.isLoading()) resolve()
      else wc.once('did-finish-load', () => resolve())
    })
    await delay(1200)

    // Deterministic start: wipe any Completed records left by earlier smoke
    // runs so the assertions never see stale state.
    internals.items = []
    internals.persist()
    await delay(100)

    completed.add({ title: 'smoke-a', filePath: scratchA, format: 'mp4', type: 'video', size: 5, sourceUrl: 'https://example.com/a' })
    completed.add({ title: 'smoke-b', filePath: scratchB, format: 'mp3', type: 'audio', size: 5, sourceUrl: 'https://example.com/b' })
    await delay(150)

    const before = (await wc.executeJavaScript('window.vidaud.getCompleted()')) as unknown[]
    report.before = before.length
    if (before.length !== 2) fail(`expected 2 seeded records, got ${before.length}`)

    // Drive the real UI path; in smoke mode the native dialog is bypassed.
    const confirmed = (await wc.executeJavaScript('window.vidaud.confirmDeleteAllCompleted()')) as boolean
    report.confirmResult = confirmed
    if (confirmed !== true) fail('confirmDeleteAllCompleted() did not confirm in smoke mode')

    // The confirmation is only a guard; the actual deletion is the Delete All
    // IPC, exactly as the UI calls it after the user confirms.
    const res = (await wc.executeJavaScript('window.vidaud.deleteAllCompleted()')) as { success?: boolean; count?: number }
    report.ipcResult = res
    if (!res?.success) fail('deleteAllCompleted() did not report success')
    if ((res?.count ?? -1) !== 2) fail(`expected count 2 for 2 seeded records, got ${res?.count}`)

    await delay(300)

    // In-memory + renderer state must be empty (immediate UI refresh via the
    // completed event the handler sends after clearing).
    const after = (await wc.executeJavaScript('window.vidaud.getCompleted()')) as unknown[]
    report.after = after.length
    if (after.length !== 0) fail(`Completed library still has ${after.length} record(s) after Delete All`)

    // Persistence (spec: records stay gone after restart): completed.json must
    // be empty, since that file is what a relaunch restores from.
    const persisted = existsSync(internals.file) ? (JSON.parse(readFileSync(internals.file, 'utf-8')) as unknown) : null
    report.persisted = Array.isArray(persisted) ? (persisted as unknown[]).length : -1
    if (!Array.isArray(persisted) || (persisted as unknown[]).length !== 0) fail('completed.json still contains records after Delete All')

    // Records only: the real files must still exist, untouched.
    if (!existsSync(scratchA) || !existsSync(scratchB)) fail('Delete All deleted files on disk (must be records-only)')

    // Deleting from an already-empty library is a no-op success (count 0).
    const res2 = (await wc.executeJavaScript('window.vidaud.deleteAllCompleted()')) as { success?: boolean; count?: number }
    report.secondCall = res2
    if (!res2?.success) fail('deleteAllCompleted() on empty library did not report success')
    if ((res2?.count ?? -1) !== 0) fail(`expected count 0 for empty library, got ${res2?.count}`)
  } catch (e) {
    fail(`smoke crashed: ${String(e)}`)
  }

  report.pass = failures.length === 0
  report.failures = failures
  const out = process.env['VIDAUD_SMOKE_COMPLETED_OUT'] ?? join(app.getPath('temp'), 'vidaud-deleteall-smoke.json')
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
  logger.info(`[smoke][deleteall] report written to ${out} -> ${report.pass ? 'PASS' : 'FAIL'}`)
  app.exit(report.pass ? 0 : 1)
}

/**
 * End-to-end Pause -> app restart -> Resume smoke test, driven by env vars:
 *   VIDAUD_SMOKE_PAUSE=1                 enable the test (both phases)
 *   VIDAUD_SMOKE_PAUSE_PHASE=a|b         a = pause mid-download + exit;
 *                                        b = restart, resume the SAME job, complete
 *   VIDAUD_SMOKE_PAUSE_OUT=<path>         JSON report destination (default: temp)
 *   VIDAUD_SMOKE_PAUSE_URL=<url>          video to download (default: rickroll)
 *   VIDAUD_SMOKE_PAUSE_QUALITY=<q>        height cap (default: 1080)
 *   VIDAUD_SMOKE_PAUSE_TRIGGER=<bytes>    pause when the .part reaches this size
 * Both phases share the isolated smoke userData, so phase b proves the app
 * restores the Paused task with its persisted attemptDir and resumes the SAME
 * `.part` job: one task id, one uniqueKey, one HISTORY row, one Completed
 * record, and the identical attempt dir reused from before the restart.
 * Exits 0 on pass, 1 on failure.
 */
async function maybeRunPauseResumeSmoke(win: BrowserWindow, queue: QueueManager, settings: SettingsManager, history: HistoryManager): Promise<void> {
  if (process.env['VIDAUD_SMOKE_PAUSE'] !== '1') return

  const phase = process.env['VIDAUD_SMOKE_PAUSE_PHASE'] ?? 'a'
  const wc = win.webContents
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const report: Record<string, unknown> = {}
  const failures: string[] = []
  const fail = (msg: string): void => {
    failures.push(msg)
  }
  const out = process.env['VIDAUD_SMOKE_PAUSE_OUT'] ?? join(app.getPath('temp'), 'vidaud-pause-smoke.json')
  const folder = process.env['VIDAUD_SMOKE_PAUSE_FOLDER'] ?? join(app.getPath('temp'), 'vidaud-pause-smoke')
  const partBytesIn = (dir: string): number => {
    try {
      if (!dir || !existsSync(dir)) return 0
      let total = 0
      for (const n of readdirSync(dir)) {
        if (n.includes('.part')) {
          try {
            total += statSync(join(dir, n)).size
          } catch {
            /* ignore */
          }
        }
      }
      return total
    } catch {
      return 0
    }
  }
  const findPartFile = (dir: string): string | null => {
    try {
      if (!dir || !existsSync(dir)) return null
      return readdirSync(dir).find((n) => n.includes('.part')) ?? null
    } catch {
      return null
    }
  }

  report.phase = phase

  const log = (msg: string): void => logger.info(`[smoke][pause] ${msg}`)

  try {
    await new Promise<void>((resolve) => {
      if (!wc.isLoading()) resolve()
      else wc.once('did-finish-load', () => resolve())
    })
    await delay(1600)

    if (phase === 'a') {
      const url = process.env['VIDAUD_SMOKE_PAUSE_URL'] ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      const kind = (process.env['VIDAUD_SMOKE_PAUSE_KIND'] ?? 'video') as 'video' | 'audio'
      const format = process.env['VIDAUD_SMOKE_PAUSE_FORMAT'] ?? 'mp4'
      const quality = process.env['VIDAUD_SMOKE_PAUSE_QUALITY'] ?? '1080'
      const trigger = Number(process.env['VIDAUD_SMOKE_PAUSE_TRIGGER'] ?? 512 * 1024)
      report.url = url
      report.kind = kind
      report.format = format
      report.quality = quality
      report.triggerBytes = trigger

      mkdirSync(folder, { recursive: true })
      settings.save({ ...settings.get(), startAutomatically: true, notifications: false, openFolderAfterDownload: false, downloadFolder: folder })

      const res = queue.addRequest({ url, kind, format, quality, title: 'pause-resume-smoke' })
      const taskId = res.taskIds[0]
      log(`phase a: added request taskId=${taskId ?? 'none'} state=${queue.getQueue().find((t) => t.id === taskId)?.state ?? 'n/a'}`)
      if (!taskId) {
        fail(`addRequest produced no task: ${JSON.stringify(res)}`)
      } else {
        report.taskId = taskId
        // Wait until the download has produced real on-disk bytes (a .part file
        // in the attempt dir), then pause through the REAL renderer IPC chain.
        let paused = false
        let attemptDir: string | undefined
        let partBytes = 0
        let partFile: string | null = null
        const deadline = Date.now() + 4 * 60 * 1000
        let lastProbe = 0
        while (Date.now() < deadline) {
          const task = queue.getQueue().find((t) => t.id === taskId)
          if (!task || task.state === 'Failed' || task.state === 'Cancelled' || task.state === 'Unavailable') {
            fail(`task ended before pause: state=${task?.state ?? 'gone'} error=${task?.error ?? ''}`)
            break
          }
          if (task.state === 'Completed') {
            fail('download completed before the pause trigger fired (pick a bigger file / lower trigger)')
            break
          }
          if (task.attemptDir && existsSync(task.attemptDir)) {
            partBytes = partBytesIn(task.attemptDir)
            if (Date.now() - lastProbe > 2000) {
              lastProbe = Date.now()
              log(`phase a: probing state=${task.state} attemptDir=${task.attemptDir} partBytes=${partBytes} files=[${readdirSync(task.attemptDir).join(',')}]`)
            }
            if (partBytes >= trigger) {
              attemptDir = task.attemptDir
              partFile = findPartFile(task.attemptDir)
              log(`phase a: trigger fired partBytes=${partBytes} -> calling window.vidaud.pause`)
              await wc.executeJavaScript(`window.vidaud.pause(${JSON.stringify(taskId)})`)
              log('phase a: pause IPC returned')
              paused = true
              break
            }
          }
          await delay(150)
        }
        if (!paused) {
          fail('never caught the download mid-flight (no .part >= trigger bytes within 4min)')
        } else {
          report.partFile = partFile
          report.partBytesAtPause = partBytes
          report.attemptDir = attemptDir
          const task0 = queue.getQueue().find((t) => t.id === taskId)
          report.uniqueKey = task0?.uniqueKey

          // Wait for the runner to observe the pause and reach the Paused state.
          const pausedDeadline = Date.now() + 60 * 1000
          let pausedState = false
          while (Date.now() < pausedDeadline) {
            const t = queue.getQueue().find((x) => x.id === taskId)
            if (t?.state === 'Paused') {
              pausedState = true
              break
            }
            if (t?.state === 'Completed') break
            await delay(200)
          }
          if (!pausedState) {
            const t = queue.getQueue().find((x) => x.id === taskId)
            log(`phase a: task never reached Paused (state=${t?.state ?? 'gone'} attemptDir=${t?.attemptDir ?? 'n/a'})`)
            fail(`task never reached Paused (state=${t?.state ?? 'gone'})`)
          } else {
            const t = queue.getQueue().find((x) => x.id === taskId)
            log(`phase a: task reached Paused state=${t?.state} attemptDir=${t?.attemptDir}`)
            if (t?.state !== 'Paused') fail(`expected Paused, got ${t?.state}`)
            if (t?.id !== taskId) fail(`task id changed after pause: ${t?.id} != ${taskId}`)
            if (t?.attemptDir !== attemptDir) fail(`attemptDir lost after pause: ${t?.attemptDir} != ${attemptDir}`)
            if (!attemptDir || !existsSync(attemptDir)) fail(`attempt dir missing after pause: ${attemptDir}`)
            const afterBytes = partBytesIn(attemptDir ?? '')
            report.partBytesAfterPause = afterBytes
            if (afterBytes === 0) fail('no .part bytes survived the pause (nothing to resume)')
          }
        }
      }
    } else if (phase === 'b') {
      // Second launch: restore() must have loaded the Paused task with its
      // persisted attemptDir. Resume it through the renderer and verify the
      // SAME job completes with no duplicate task / HISTORY / Completed record.
      const prior = JSON.parse(readFileSync(out, 'utf-8')) as Record<string, unknown>
      report.phaseA = prior
      const priorTaskId = String(prior.taskId ?? '')
      const priorAttemptDir = String(prior.attemptDir ?? '')
      const priorUniqueKey = String(prior.uniqueKey ?? '')
      report.priorTaskId = priorTaskId
      report.priorAttemptDir = priorAttemptDir

      if (!priorTaskId) {
        fail('phase A report has no taskId')
      } else {
        const task = queue.getQueue().find((t) => t.id === priorTaskId)
        if (!task) {
          fail(`restored task not found (id=${priorTaskId})`)
        } else {
          report.restoredState = task.state
          report.restoredAttemptDir = task.attemptDir
          report.restoredPartBytes = partBytesIn(task.attemptDir ?? '')
          if (task.state !== 'Paused') fail(`restored task should be Paused, got ${task.state}`)
          if (task.attemptDir !== priorAttemptDir) fail(`restored attemptDir changed across restart: ${task.attemptDir} != ${priorAttemptDir}`)
          if (!task.attemptDir || !existsSync(task.attemptDir)) fail(`restored attempt dir missing: ${task.attemptDir}`)
          if (partBytesIn(task.attemptDir ?? '') === 0) fail('restored attempt dir has no .part bytes')
          const histRows = history.list().filter((h) => h.uniqueKey === task.uniqueKey)
          report.restoredHistoryRows = histRows.length
          if (histRows.length !== 1) fail(`expected 1 HISTORY row for uniqueKey, got ${histRows.length}`)

          // Now resume the SAME job through the real renderer IPC chain.
          await wc.executeJavaScript(`window.vidaud.resume(${JSON.stringify(task.id)})`)
          const completedDeadline = Date.now() + 10 * 60 * 1000
          let done: DownloadTask | undefined
          while (Date.now() < completedDeadline) {
            const t = queue.getQueue().find((x) => x.id === task.id)
            if (!t) break
            if (t.state === 'Completed') {
              done = t
              break
            }
            if (t.state === 'Failed' || t.state === 'Cancelled') {
              fail(`task ended during resume: state=${t.state} error=${t.error ?? ''}`)
              break
            }
            await delay(1000)
          }
          if (!done) {
            const t = queue.getQueue().find((x) => x.id === task.id)
            fail(`task never reached Completed after resume (state=${t?.state ?? 'gone'})`)
          } else {
            report.completedTaskId = done.id
            report.completedUniqueKey = done.uniqueKey
            report.completedAttemptDir = done.attemptDir
            report.filePath = done.filePath
            report.fileSize = done.fileSize
            if (done.id !== priorTaskId) fail(`completed task id differs: ${done.id} != ${priorTaskId}`)
            if (done.uniqueKey !== priorUniqueKey) fail(`completed uniqueKey differs: ${done.uniqueKey} != ${priorUniqueKey}`)
            if (done.attemptDir !== priorAttemptDir) fail(`attemptDir changed across resume: ${done.attemptDir} != ${priorAttemptDir} (must reuse the paused dir)`)
            if (!done.filePath || !existsSync(done.filePath)) fail(`final file missing: ${done.filePath}`)
            if (!done.fileSize || done.fileSize === 0) fail('final file size is 0')
            const rows = history.list().filter((h) => h.uniqueKey === done.uniqueKey)
            report.finalHistoryRows = rows.length
            if (rows.length !== 1) fail(`expected exactly 1 HISTORY row, got ${rows.length}`)
            const doneRows = rows.filter((h) => h.status === 'completed')
            if (doneRows.length !== 1) fail(`expected HISTORY status 'completed', got ${rows.map((r) => r.status).join(',')}`)
            const completedItems = queue.getCompletedItems().filter((c) => c.uniqueKey === done.uniqueKey)
            report.finalCompletedRecords = completedItems.length
            if (completedItems.length !== 1) fail(`expected exactly 1 Completed record, got ${completedItems.length}`)
          }
        }
      }
    } else {
      fail(`unknown phase: ${phase}`)
    }
  } catch (e) {
    log(`phase crashed: ${String(e)}`)
    fail(`pause/resume smoke crashed: ${String(e)}`)
  }

  report.pass = failures.length === 0
  report.failures = failures
  try {
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
    log(`report written to ${out} -> ${report.pass ? 'PASS' : 'FAIL'} (${failures.length} failure(s))`)
  } catch (e) {
    log(`report write failed: ${String(e)}`)
  }
  app.exit(report.pass ? 0 : 1)
}

/**
 * End-to-end Converter smoke test, driven by env vars:
 *   VIDAUD_SMOKE_CONVERTER=1            enable the test
 *   VIDAUD_SMOKE_CONVERTER_OUT=<path>    JSON report destination (default: temp)
 * Generates a real sample video with the bundled FFmpeg, then runs the full
 * converter chain through IPC in the real renderer: detect -> pick mp3 ->
 * convert -> job reaches Completed -> validated output exists on disk ->
 * Completed library contains the converted item (source=converter).
 * Exits 0 on pass, 1 on failure.
 */
async function maybeRunConverterSmoke(win: BrowserWindow, settings: SettingsManager, converter: ConverterManager, ffmpeg: FfmpegManager): Promise<void> {
  if (process.env['VIDAUD_SMOKE_CONVERTER'] !== '1') return

  const workDir = join(app.getPath('temp'), 'vidaud-conv-smoke')
  mkdirSync(workDir, { recursive: true })
  settings.save({
    ...settings.get(),
    language: 'en',
    notifications: false,
    converterOutputFolder: workDir,
    onExistingFile: 'replace'
  })

  const wc = win.webContents
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const report: Record<string, unknown> = {}
  const failures: string[] = []
  const fail = (msg: string): void => {
    failures.push(msg)
  }

  try {
    await new Promise<void>((resolve) => {
      if (!wc.isLoading()) resolve()
      else wc.once('did-finish-load', () => resolve())
    })
    await delay(1600)

    // 0. Navigate to the Converter page and verify the redesign mounted.
    await wc.executeJavaScript(`document.querySelectorAll('.nav-item')[4].click()`)
    await delay(450)
    const pageMounted = (await wc.executeJavaScript(`!!document.querySelector('.converter-dropzone')`)) as boolean
    report.pageMounted = pageMounted
    if (!pageMounted) fail('converter page did not render (dropzone missing)')

    // 1. Generate a real 2s sample video (H.264 + AAC) with the bundled FFmpeg.
    const sample = join(workDir, 'sample.mp4')
    const gen = await ffmpeg.run([
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      sample
    ])
    if (gen.code !== 0 || !existsSync(sample)) {
      fail(`could not generate sample video (code ${gen.code})`)
    } else {
      report.sampleGenerated = true
    }

    // 2. Detect through the real IPC bridge in the renderer.
    await wc.executeJavaScript(`(() => { window.__cvProg = []; window.vidaud.onConverterDetectProgress(p => { window.__cvProg.push(p) }); return true })()`)
    const detected = (await wc.executeJavaScript(`window.vidaud.detectFiles([${JSON.stringify(sample)}])`)) as Array<{ path: string; category: string; targets: Array<{ id: string }> }>
    const progressEvents = (await wc.executeJavaScript('window.__cvProg')) as Array<{ done: number; total: number }>
    report.detectProgress = progressEvents
    if (progressEvents.length === 0) fail('detect-progress events were not emitted')
    const lastProgress = progressEvents[progressEvents.length - 1]
    if (!lastProgress || lastProgress.done !== 1 || lastProgress.total !== 1) fail(`unexpected detect progress ${JSON.stringify(lastProgress)}`)
    report.detected = detected
    const d = detected && detected[0]
    if (!d || d.category !== 'video') fail(`expected video category, got ${d?.category}`)
    if (!d.targets.some((t) => t.id === 'mp3')) fail('mp3 target missing for video input')

    // 3. Convert sample.mp4 -> sample.mp3 through the IPC bridge.
    const convRes = (await wc.executeJavaScript(`window.vidaud.convertFiles({ paths: [${JSON.stringify(sample)}], targetId: 'mp3' })`)) as { ok: boolean; error?: string }
    report.convertStart = convRes
    if (!convRes?.ok) fail(`convertFiles did not report ok: ${JSON.stringify(convRes)}`)

    // 4. Poll the queue until the job leaves Converting/Processing.
    let job: { state: string; outputName?: string; error?: string } | undefined
    for (let i = 0; i < 120; i++) {
      const jobs = (await wc.executeJavaScript('window.vidaud.getConverterJobs()')) as Array<{ state: string; outputName?: string; error?: string }>
      job = jobs && jobs[0]
      if (job && (job.state === 'Completed' || job.state === 'Failed' || job.state === 'Cancelled')) break
      await delay(500)
    }
    report.job = job
    if (!job) fail('job never appeared in the converter queue')
    else if (job.state !== 'Completed') fail(`expected Completed, got ${job.state} (${job.error ?? ''})`)

    const expectedOut = join(workDir, 'sample.mp3')
    report.outputExists = existsSync(expectedOut)
    if (job?.outputName !== 'sample.mp3' || !existsSync(expectedOut)) fail('expected output sample.mp3 was not produced on disk')

    // 5. Validate the produced file can be read back, then check Completed.
    if (existsSync(expectedOut)) {
      const ok = await ffmpeg.validate(expectedOut)
      report.outputValid = ok
      if (!ok) fail('produced mp3 failed validation')
    }
    const completed = (await wc.executeJavaScript('window.vidaud.getCompleted()')) as Array<{ source?: string; fileName?: string; format?: string }>
    report.completed = completed[0]
    if (!completed.some((c) => c.source === 'converter' && c.fileName === 'sample.mp3')) {
      fail('converted item missing from Completed library (source=converter)')
    }

    // 6. Batch API: per-file targets in a single round-trip (mixed formats).
    const batch = (await wc.executeJavaScript(`window.vidaud.convertFiles({ items: [{ path: ${JSON.stringify(sample)}, targetId: 'mkv' }] })`)) as { ok: boolean; error?: string; added?: number; unavailable?: number }
    report.batchConvert = batch
    if (!batch?.ok || (batch.added ?? 0) !== 1) fail(`batch convertFiles({ items }) did not queue the file: ${JSON.stringify(batch)}`)

    // Wait for the whole queue to settle before the next round.
    const waitIdle = async (): Promise<void> => {
      for (let i = 0; i < 240; i++) {
        const jobs = (await wc.executeJavaScript('window.vidaud.getConverterJobs()')) as Array<{ state: string }>
        const settled = jobs.every((j) => j.state === 'Completed' || j.state === 'Failed' || j.state === 'Cancelled')
        if (settled) return
        await delay(250)
      }
    }
    await waitIdle()
    const mkvExists = existsSync(join(workDir, 'sample.mkv'))
    report.mkvExists = mkvExists
    if (!mkvExists) fail('batch mkv output was not produced on disk')

    // 7. Thumbnail API: a file:// preview must be produced for the sample video.
    const thumb = (await wc.executeJavaScript(`window.vidaud.getFileThumbnail(${JSON.stringify(sample)})`)) as string | null
    report.thumbnail = thumb
    if (typeof thumb !== 'string' || !thumb.startsWith('file://')) fail('thumbnail was not a file:// URL')

    // 8. Advanced options must reach FFmpeg: 44.1 kHz stereo PCM WAV.
    const advRes = (await wc.executeJavaScript(
      `window.vidaud.convertFiles({ items: [{ path: ${JSON.stringify(sample)}, targetId: 'wav', advanced: { audioCodec: 'pcm_s16le', sampleRate: 44100, channels: 2 } }] })`
    )) as { ok: boolean; error?: string; added?: number; unavailable?: number }
    report.advConvert = advRes
    if (!advRes?.ok || (advRes.added ?? 0) !== 1) fail(`advanced convertFiles did not queue: ${JSON.stringify(advRes)}`)
    await waitIdle()
    const expectedWav = join(workDir, 'sample.wav')
    report.advOutputExists = existsSync(expectedWav)
    if (!existsSync(expectedWav)) fail('advanced wav output was not produced on disk')
    const wavProbe = await ffmpeg.probe(expectedWav)
    report.wavProbe = { sampleRate: wavProbe.sampleRate, channels: wavProbe.channels }
    if (wavProbe.sampleRate !== 44100 || wavProbe.channels !== 2) fail(`advanced settings not applied: got ${wavProbe.sampleRate}Hz/${wavProbe.channels}ch, expected 44100Hz/2ch`)
    const wavOk = await ffmpeg.validate(expectedWav)
    report.advOutputValid = wavOk
    if (!wavOk) fail('advanced wav output failed validation')

    // 9. PDF -> PNG through the bundled pdfjs engine (FFmpeg cannot read PDFs).
    const pdfB64 =
      'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA1OTUgODQyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA3IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NiA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDEwMCA3ODAgVGQgKFZJREFVRCBQREYgdGVzdCBwYWdlIG9uZSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNTk1IDg0Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNyAwIFIgPj4gPj4gL0NvbnRlbnRzIDYgMCBSID4+CmVuZG9iago2IDAgb2JqCjw8IC9MZW5ndGggNTYgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiAxMDAgNzgwIFRkIChWSURBVUQgUERGIHRlc3QgcGFnZSB0d28pIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNyAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnRyYWlsZXIKPDwgL1Jvb3QgMSAwIFIgL1NpemUgOCA+PgolJUVPRg=='
    const samplePdf = join(workDir, 'sample.pdf')
    writeFileSync(samplePdf, Buffer.from(pdfB64, 'base64'))
    const pdfDetected = (await wc.executeJavaScript(`window.vidaud.detectFiles([${JSON.stringify(samplePdf)}])`)) as Array<{ category: string; targets: Array<{ id: string }> }>
    report.pdfDetected = pdfDetected
    const pd = pdfDetected && pdfDetected[0]
    if (!pd || pd.category !== 'pdf') fail(`expected pdf category, got ${pd?.category}`)
    if (!pd.targets.some((t) => t.id === 'png') || !pd.targets.some((t) => t.id === 'jpg')) fail('pdf targets should include png and jpg')

    const pdfRes = (await wc.executeJavaScript(`window.vidaud.convertFiles({ paths: [${JSON.stringify(samplePdf)}], targetId: 'png' })`)) as { ok: boolean; error?: string }
    report.pdfConvert = pdfRes
    if (!pdfRes?.ok) fail(`pdf convertFiles did not report ok: ${JSON.stringify(pdfRes)}`)

    let pdfJob: { state: string; pageCount?: number; outputName?: string; error?: string } | undefined
    for (let i = 0; i < 120; i++) {
      const jobs = (await wc.executeJavaScript('window.vidaud.getConverterJobs()')) as Array<{ state: string; pageCount?: number; outputName?: string; error?: string; inputName?: string }>
      pdfJob = jobs.find((j) => j.inputName === 'sample.pdf')
      if (pdfJob && (pdfJob.state === 'Completed' || pdfJob.state === 'Failed' || pdfJob.state === 'Cancelled')) break
      await delay(500)
    }
    report.pdfJob = pdfJob
    if (!pdfJob) fail('pdf job never appeared in the converter queue')
    else if (pdfJob.state !== 'Completed') fail(`pdf job expected Completed, got ${pdfJob.state} (${pdfJob.error ?? ''})`)
    else if (pdfJob.pageCount !== 2) fail(`expected 2 pages, got ${pdfJob.pageCount}`)

    const pdfOutDir = join(workDir, 'sample-png')
    // Page files use the sanitized input stem as prefix: sample-001.png, ...
    const page1 = join(pdfOutDir, 'sample-001.png')
    const page2 = join(pdfOutDir, 'sample-002.png')
    report.pdfPage1Exists = existsSync(page1)
    report.pdfPage2Exists = existsSync(page2)
    if (!existsSync(page1) || !existsSync(page2)) fail('pdf page images were not produced on disk')

    // 10. Completed library: the PDF folder is registered with source=converter and originalFormat=pdf.
    const pdfCompleted = (await wc.executeJavaScript('window.vidaud.getCompleted()')) as Array<{ source?: string; fileName?: string; format?: string; originalFormat?: string }>
    report.pdfCompleted = pdfCompleted.find((c) => c.source === 'converter' && c.fileName === 'sample-png')
    if (!pdfCompleted.some((c) => c.source === 'converter' && c.fileName === 'sample-png' && c.originalFormat === 'pdf')) {
      fail('pdf converted item missing from Completed library (source=converter, originalFormat=pdf)')
    }
  } catch (e) {
    fail(`converter smoke crashed: ${String(e)}`)
  }

  report.pass = failures.length === 0
  report.failures = failures
  const out = process.env['VIDAUD_SMOKE_CONVERTER_OUT'] ?? join(app.getPath('temp'), 'vidaud-converter-smoke.json')
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
  logger.info(`[smoke][converter] report written to ${out} -> ${report.pass ? 'PASS' : 'FAIL'}`)
  app.exit(report.pass ? 0 : 1)
}

/**
 * Build a minimal, spec-valid PDF with `pageCount` pages, each carrying a
 * distinct English text line, so smoke tests can run without any fixture file.
 * Offsets are computed while writing so the xref table is exact.
 */
function createSmokePdf(pageCount: number, title: string): Buffer {
  const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const contentOf = (page: number): string => `BT /F1 14 Tf 72 770 Td (${escape(`${title} - page ${page}`)}) Tj ET\n`

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  const obj = (num: number, body: string): void => {
    offsets[num] = out.length
    out += `${num} 0 obj\n${body}\nendobj\n`
  }

  const fontNum = 3 + pageCount * 2
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`)
  for (let i = 0; i < pageCount; i++) {
    const pageNum = 3 + i * 2
    const contentNum = pageNum + 1
    const stream = contentOf(i + 1)
    obj(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`)
    obj(contentNum, `<< /Length ${stream.length} >>\nstream\n${stream}endstream`)
  }
  obj(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')

  const xrefStart = out.length
  out += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/**
 * Build a single-page "scanned" PDF: a rasterized image (drawn with the same
 * canvas library the viewer uses) embedded as a JPEG with no text layer, so
 * smoke tests exercise the real OCR pipeline (image-only page -> recognize).
 */
function createSmokeScannedPdf(): Buffer {
  const W = 1200
  const H = 400
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#111111'
  ctx.font = '64px sans-serif'
  ctx.fillText('Scanned invoice example 2026', 60, 220)
  const jpegLatin1 = canvas.toBuffer('image/jpeg', 80).toString('latin1')

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  const obj = (num: number, body: string): void => {
    offsets[num] = out.length
    out += `${num} 0 obj\n${body}\nendobj\n`
  }

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 6 0 R >> >> >>'
  )
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}endstream`)
  obj(
    6,
    `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegLatin1.length} >>\nstream\n${jpegLatin1}endstream`
  )

  const xrefStart = out.length
  out += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}


/**
 * URL classifier smoke test, driven by env vars:
 *   VIDAUD_SMOKE_CLASSIFY=1                    enable the test
 *   VIDAUD_SMOKE_CLASSIFY_URLS="u1,u2,u3"      URLs to classify (comma-separated)
 *   VIDAUD_SMOKE_CLASSIFY_EXPECT="image|error" per-URL expected outcome
 *     (one of: image | gallery | video | playlist | error)
 *   VIDAUD_SMOKE_CLASSIFY_OUT=<path>           JSON report destination
 * Runs the REAL analyzeUrl pipeline (yt-dlp + redirect probe + web-image
 * extraction) for each URL and asserts the classification. Exits 0 on pass.
 */
async function maybeRunClassifierSmoke(): Promise<void> {
  if (process.env['VIDAUD_SMOKE_CLASSIFY'] !== '1') return
  const rawUrl = process.env['VIDAUD_SMOKE_CLASSIFY_URLS'] ?? ''
  const urls = rawUrl
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const expects = (process.env['VIDAUD_SMOKE_CLASSIFY_EXPECT'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const report: Record<string, unknown> = {}
  const failures: string[] = []
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const want = expects[i] ?? ''
    const row: Record<string, unknown> = { url }
    try {
      const info = await analyzeWithCache(url, -1)
      const actualKind = info.type === 'image-gallery' ? 'gallery' : info.type
      row.actual = actualKind
      row.title = info.title
      row.imageExt = info.imageExt ?? undefined
      row.fileSize = info.fileSize ?? undefined
      row.imageCount = info.type === 'image-gallery' ? (info.downloadableCount ?? info.entries.length) : undefined
      if (want && actualKind !== want) {
        failures.push(`${url}: expected ${want}, got ${actualKind}`)
      }
    } catch (e) {
      row.actual = 'error'
      row.errorCode = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : undefined
      row.error = e instanceof Error ? e.message : String(e)
      if (want && want !== 'error') failures.push(`${url}: expected ${want}, got error (${row.errorCode ?? '?'}: ${row.error})`)
    }
    report[url] = row
  }
  report.pass = failures.length === 0
  report.failures = failures
  const out = process.env['VIDAUD_SMOKE_CLASSIFY_OUT'] ?? join(app.getPath('temp'), 'vidaud-classify-smoke.json')
  try {
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
    logger.info(`[smoke][classify] report written to ${out} -> ${report.pass ? 'PASS' : 'FAIL'}`)
  } catch (e) {
    logger.info(`[smoke][classify] report write failed: ${String(e)}`)
  }
  app.exit(report.pass ? 0 : 1)
}

/**
 * Clipboard Paste smoke test, driven by env vars:
 *   VIDAUD_SMOKE_CLIPBOARD=1            enable the test
 *   VIDAUD_SMOKE_CLIPBOARD_OUT=<path>    JSON report destination (default: temp)
 * Verifies the REAL chain main clipboard -> preload IPC -> Dashboard Paste
 * button -> URL input -> Analyze, using the actual renderer:
 * TEST 1 video URL pastes, TEST 4 image URL pastes, TEST 5 long URL pastes
 * in full, TEST 6 empty clipboard shows "Clipboard is empty.", non-text
 * clipboard shows the no-text message, and TEST 7 Analyze attempts the newly
 * pasted URL (stale-empty state would no-op instead). Exits 0 on pass.
 */
async function maybeRunClipboardSmoke(win: BrowserWindow, settings: SettingsManager): Promise<void> {
  if (process.env['VIDAUD_SMOKE_CLIPBOARD'] !== '1') return

  const wc = win.webContents
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const report: Record<string, unknown> = {}
  const failures: string[] = []
  const fail = (msg: string): void => {
    failures.push(msg)
  }

  const YT_URL = 'https://www.youtube.com/watch?v=test'
  const IMG_URL = 'https://example.com/image.jpg'
  const LONG_URL = 'https://www.google.com/search?q=cute+cats&tbm=isch&sa=X&ved=2ahUKEwjTest123&biw=1920&bih=953#imgrc=abcDEF123'

  try {
    await new Promise<void>((resolve) => {
      if (!wc.isLoading()) resolve()
      else wc.once('did-finish-load', () => resolve())
    })
    await delay(1800)
    settings.save({ ...settings.get(), language: 'en', notifications: false })

    const clickPaste = (): Promise<void> =>
      wc.executeJavaScript(`(() => { const btns = document.querySelectorAll('.url-input-actions button'); if (btns.length > 0) (btns[0]).click(); return true })()`) as Promise<void>
    const inputValue = (): Promise<string> => wc.executeJavaScript(`document.querySelector('.url-input')?.value ?? ''`) as Promise<string>

    // Bridge sanity: main clipboard -> preload IPC round-trip.
    clipboard.writeText(YT_URL)
    const bridge = (await wc.executeJavaScript('window.electronAPI.readClipboardText()')) as { success?: boolean; text?: string; empty?: boolean }
    report.bridge = bridge
    if (!bridge?.success || bridge.text !== YT_URL) fail(`preload bridge round-trip failed: ${JSON.stringify(bridge)}`)

    // TEST 1: Paste button inserts a video URL into the input.
    await clickPaste()
    await delay(700)
    const v1 = await inputValue()
    report.test1 = v1
    if (v1 !== YT_URL) fail(`TEST 1: expected input '${YT_URL}', got '${v1}'`)

    // TEST 4: image URLs paste exactly like any other URL.
    clipboard.writeText(IMG_URL)
    await clickPaste()
    await delay(700)
    const v4 = await inputValue()
    report.test4 = v4
    if (v4 !== IMG_URL) fail(`TEST 4: expected input '${IMG_URL}', got '${v4}'`)

    // TEST 5: long URLs arrive in full, nothing truncated or corrupted.
    clipboard.writeText(LONG_URL)
    await clickPaste()
    await delay(700)
    const v5 = await inputValue()
    report.test5len = v5.length
    if (v5 !== LONG_URL) fail(`TEST 5: long URL corrupted (len ${v5.length} vs ${LONG_URL.length})`)

    // TEST 6: empty clipboard shows the empty message, input untouched.
    clipboard.clear()
    await clickPaste()
    await delay(700)
    const bodyEmpty = (await wc.executeJavaScript('document.body.textContent ?? \'\'')) as string
    report.test6msg = bodyEmpty.includes('Clipboard is empty.')
    if (!bodyEmpty.includes('Clipboard is empty.')) fail('TEST 6: "Clipboard is empty." message not shown')
    const v6 = await inputValue()
    if (v6 !== LONG_URL) fail(`TEST 6: input changed on empty paste (got '${v6}')`)

    // Non-text clipboard (image, no text) shows the no-text message.
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    clipboard.writeImage(nativeImage.createFromBuffer(png1x1))
    await clickPaste()
    await delay(700)
    const bodyImg = (await wc.executeJavaScript('document.body.textContent ?? \'\'')) as string
    report.nonTextMsg = bodyImg.includes('No text URL found in clipboard.')
    if (!bodyImg.includes('No text URL found in clipboard.')) fail('non-text clipboard message not shown')

    // TEST 7: Analyze receives the newly pasted URL, not a stale value.
    // A stale-empty state returns before setAnalyzing with zero UI change, so
    // any settled outcome (media card or analyzer error box) proves the fresh
    // URL reached the analyzer. The transient "Analyzing" label is NOT polled:
    // fast failures (e.g. missing binary) settle in milliseconds.
    clipboard.writeText(YT_URL)
    await clickPaste()
    await delay(700)
    const before = await inputValue()
    if (before !== YT_URL) fail(`TEST 7 setup: input is '${before}', expected '${YT_URL}'`)
    else {
      const analyzeBtn = `Array.from(document.querySelectorAll('.url-row button')).find((x) => (x.textContent || '').includes('Analyz'))`
      const clicked = (await wc.executeJavaScript(`(() => { const b = ${analyzeBtn}; if (b) b.click(); return !!b })()`)) as boolean
      if (!clicked) fail('TEST 7: Analyze button not found')
      else {
        let settled = false
        const endDeadline = Date.now() + 90 * 1000
        while (Date.now() < endDeadline) {
          const probe = (await wc.executeJavaScript(
            `({ media: !!document.querySelector('.media-card'), extra: (document.querySelector('.url-row')?.parentElement?.children.length ?? 1) > 1, busy: (() => { const b = ${analyzeBtn}; return b ? (b.textContent || '').includes('Analyzing') : false })() })`
          )) as { media?: boolean; extra?: boolean; busy?: boolean }
          if (!probe.busy && (probe.media || probe.extra)) {
            settled = true
            report.test7outcome = probe.media ? 'media' : 'analyzer-error'
            break
          }
          await delay(1000)
        }
        report.test7settled = settled
        if (!settled) fail('TEST 7: Analyze produced no result for the pasted URL (stale state?)')
      }
    }
  } catch (e) {
    fail(`smoke crashed: ${String(e)}`)
  }

  report.pass = failures.length === 0
  report.failures = failures
  const out = process.env['VIDAUD_SMOKE_CLIPBOARD_OUT'] ?? join(app.getPath('temp'), 'vidaud-clipboard-smoke.json')
  try {
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
    logger.info(`[smoke][clipboard] report written to ${out} -> ${report.pass ? 'PASS' : 'FAIL'}`)
  } catch (e) {
    logger.info(`[smoke][clipboard] report write failed: ${String(e)}`)
  }
  app.exit(report.pass ? 0 : 1)
}

/**
 * Window-controls smoke test, driven by env vars:
 *   VIDAUD_SMOKE_WINDOW=1            enable the test
 *   VIDAUD_SMOKE_WINDOW_OUT=<path>    JSON report destination (default: temp)
 * Exercises the REAL window buttons through the full chain
 * renderer -> preload -> IPC -> WindowController -> BrowserWindow:
 * isWindowMaximized, toggleMaximizeWindow (maximize), toggleMaximizeWindow
 * (restore), minimizeWindow, closeWindow. Exits 0 on pass, 1 on failure.
 */
async function maybeRunWindowSmoke(win: BrowserWindow, queue: QueueManager): Promise<void> {
  if (process.env['VIDAUD_SMOKE_WINDOW'] !== '1') return

  const wc = win.webContents
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const report: Record<string, unknown> = {}
  const failures: string[] = []
  const fail = (msg: string): void => {
    failures.push(msg)
  }

  try {
    await new Promise<void>((resolve) => {
      if (!wc.isLoading()) resolve()
      else wc.once('did-finish-load', () => resolve())
    })
    await delay(1600)

    const apiType = (await wc.executeJavaScript('typeof window.electronAPI')) as string
    report.apiType = apiType
    if (apiType !== 'object') fail(`electronAPI is not exposed (typeof=${apiType})`)

    if (failures.length === 0) {
      const methods = (await wc.executeJavaScript('Object.keys(window.electronAPI).sort().join(",")')) as string
      report.methods = methods
      const needed = ['closeWindow', 'isWindowMaximized', 'minimizeWindow', 'toggleMaximizeWindow', 'onWindowStateChanged']
      for (const m of needed) {
        if (!methods.split(',').includes(m)) fail(`electronAPI.${m} missing (got ${methods})`)
      }
    }

    if (failures.length === 0) {
      const isMax = (await wc.executeJavaScript('window.electronAPI.isWindowMaximized()')) as { success: boolean; maximized: boolean }
      report.initialMaximized = isMax?.maximized
      if (!isMax?.success || typeof isMax.maximized !== 'boolean') fail(`isWindowMaximized failed: ${JSON.stringify(isMax)}`)
      // VIDAUD opens Maximized by default, so restore first to reach a known
      // un-maximized state before the toggle assertions below.
      if (isMax?.maximized) {
        await wc.executeJavaScript('window.electronAPI.toggleMaximizeWindow()')
        await delay(700)
      }
    }

    if (failures.length === 0) {
      const t1 = (await wc.executeJavaScript('window.electronAPI.toggleMaximizeWindow()')) as { success: boolean; maximized: boolean }
      if (!t1?.success || t1.maximized !== true) fail(`maximize failed: ${JSON.stringify(t1)}`)
      await delay(700)
      const isMax2 = (await wc.executeJavaScript('window.electronAPI.isWindowMaximized()')) as { success: boolean; maximized: boolean }
      if (!isMax2?.maximized) fail(`window is not maximized after toggle: ${JSON.stringify(isMax2)}`)
    }

    if (failures.length === 0) {
      const t2 = (await wc.executeJavaScript('window.electronAPI.toggleMaximizeWindow()')) as { success: boolean; maximized: boolean }
      if (!t2?.success || t2.maximized !== false) fail(`restore failed: ${JSON.stringify(t2)}`)
      await delay(500)
      const min = (await wc.executeJavaScript('window.electronAPI.minimizeWindow()')) as { success: boolean }
      if (!min?.success) fail(`minimize failed: ${JSON.stringify(min)}`)
      await delay(700)
      win.restore()
      await delay(700)
    }

    if (failures.length === 0) {
      // Pause any real downloads so the close handler skips the active-downloads
      // dialog and we can verify the full close path end-to-end.
      queue.pauseAll()
      await delay(500)
      // Fire closeWindow through the full renderer chain WITHOUT awaiting its
      // result (the renderer is destroyed the moment the window closes).
      await wc.executeJavaScript('void window.electronAPI.closeWindow()')
      const closed = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 6000)
        win.once('closed', () => {
          clearTimeout(t)
          resolve(true)
        })
      })
      if (!closed) fail('closeWindow did not close the window')
    }
  } catch (e) {
    fail(`window smoke crashed: ${String(e)}`)
  }

  report.pass = failures.length === 0
  report.failures = failures
  const out = process.env['VIDAUD_SMOKE_WINDOW_OUT'] ?? join(app.getPath('temp'), 'vidaud-window-smoke.json')
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
  logger.info(`[smoke][window] report written to ${out} -> ${report.pass ? 'PASS' : 'FAIL'}`)
  app.exit(report.pass ? 0 : 1)
}

function createWindow(): void {
  const primary = screen.getPrimaryDisplay().bounds
  const saved = windowState.get()
  const bounds = {
    x: saved.x ?? primary.x,
    y: saved.y ?? primary.y,
    width: saved.width ?? primary.width,
    height: saved.height ?? primary.height
  }

  mainWindow = new BrowserWindow({
    title: 'VIDAUD',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    autoHideMenuBar: true,
    show: false,
    maximizable: true,
    resizable: true,
    backgroundColor: '#0e1015',
    icon: join(__dirname, '../../resources/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  // The window is created hidden (show: false) and maximized BEFORE it ever
  // becomes visible, so VIDAUD appears directly in its final state instead of
  // flashing a small window that then grows. Maximized is the default on the
  // first run; afterwards the saved state from the last close is restored.
  if (saved.maximized) {
    mainWindow.maximize()
  }

  const win = mainWindow

  // Bind the single WindowController to the live window so IPC handlers always
  // operate on the real instance (never a stale or null reference).
  if (windowController) {
    windowController.setWindow(win)
  } else {
    windowController = new WindowController(win)
  }

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // Persist the current geometry + maximize flag so the next launch restores
  // exactly the state the window was closed in (Maximized stays Maximized, a
  // manually restored Normal window keeps its position/size).
  win.on('close', () => {
    if (!win.isDestroyed()) {
      windowState.capture(win)
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Native Cut / Copy / Paste / Select All on right-click inside editable
  // fields (e.g. the Dashboard URL input). Electron shows no context menu by
  // default, so right-click paste would otherwise do nothing. Non-editable
  // areas intentionally get no menu. Nothing here disables typing or Ctrl+V.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' }
    ])
    menu.popup({ window: win })
  })

  // Emit window-state events so the renderer's maximize/restore icon
  // updates automatically regardless of how the window was resized.
  mainWindow.on('maximize', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('window-state-changed', { maximized: true })
        win.webContents.send(IPC.events.windowMaximized)
      }
    }
  })
  mainWindow.on('unmaximize', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('window-state-changed', { maximized: false })
        win.webContents.send(IPC.events.windowUnmaximized)
      }
    }
  })
  mainWindow.on('restore', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('window-state-changed', { maximized: false })
        win.webContents.send(IPC.events.windowUnmaximized)
      }
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.vidaud.app')

    const settings = new SettingsManager()
    windowState = new WindowStateManager()
    const history = new HistoryManager()
    const completed = new CompletedManager()
    const notifications = new NotificationManager()
    const playlists = new PlaylistManager()
    const queue = new QueueManager(settings, history, notifications, playlists, completed)
    const ffmpeg = new FfmpegManager()
    const converter = new ConverterManager(settings, ffmpeg, completed, history)

    // The window must exist BEFORE the IPC handlers are registered: window
    // controls resolve the controller's BrowserWindow reference at call time.
    createWindow()
    registerIpc(queue, settings, history, completed, windowController!, converter)
    void loadAnalyzeCache()

    // Optional end-to-end smoke download, driven by env vars (used for CI/verification).
    void maybeRunSmoke(queue, settings)

    history.onChange((entries) => {
      const statistics = calculateStatistics(entries)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.events.history, entries)
          win.webContents.send(IPC.events.statistics, statistics)
          if (entries.length === 0) win.webContents.send(IPC.events.historyCleared)
        }
      }
    })

    completed.onChange((items) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.events.completed, items)
        }
      }
    })

    screen.on('display-metrics-changed', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const display = screen.getDisplayMatching(mainWindow.getBounds())
        if (display && !mainWindow.isMaximized()) {
          mainWindow.setBounds(display.bounds)
        }
      }
    })

    powerMonitor.on('resume', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const display = screen.getDisplayMatching(mainWindow.getBounds())
        if (display && !mainWindow.isMaximized()) {
          mainWindow.setBounds(display.bounds)
        }
      }
    })

    const w = BrowserWindow.getAllWindows()[0]
    if (w) {
      void maybeRunHistorySmoke(w, settings)
      void maybeRunClipboardSmoke(w, settings)
      void maybeRunClassifierSmoke()
      void maybeRunWindowSmoke(w, queue)
      void maybeRunConverterSmoke(w, settings, converter, ffmpeg)
      void maybeRunClearCompletedSmoke(w, queue)
      void maybeRunDeleteAllCompletedSmoke(w, completed)
      void maybeRunPauseResumeSmoke(w, queue, settings, history)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.env['VIDAUD_SMOKE_WINDOW'] === '1') return
    app.quit()
  })

  app.on('will-quit', () => {
  })
}
