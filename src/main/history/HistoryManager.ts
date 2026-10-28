import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { HistoryEntry, HistoryStatus } from '@shared/types'
import { ACTIVE_STATUSES, normalizeHistoryStatus } from '@shared/statistics'
import { hasRealFileName } from '../utils/title'
import { logger } from '../utils/logger'

const MAX_ENTRIES = 2000

type NewEntry = Omit<HistoryEntry, 'id' | 'date'> & { date?: number; uniqueKey?: string; id?: string }

export class HistoryManager {
  private entries: HistoryEntry[] = []
  private file: string
  /** Exact text of the last file content we read/wrote (valid or not), used to detect external edits. */
  private lastReadContent: string | null = null
  private listeners: Array<(entries: HistoryEntry[]) => void> = []

  constructor() {
    const userData = app.getPath('userData')
    if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
    this.file = join(userData, 'history.json')
    logger.info(`[VIDAUD][HISTORY] Storage: ${this.file}`)
    this.load()
  }

  /**
   * Migration + repair pipeline for the persistent store:
   *   Load records -> Deduplicate by uniqueKey -> Normalize statuses ->
   *   Drop invalid records -> Recalculate order -> Trim to capacity.
   * The result is rewritten to disk so it never reappears on a later launch.
   * Records are the ONLY source for Dashboard/Header statistics.
   */
  private load(): void {
    try {
      if (existsSync(this.file)) {
        const raw = readFileSync(this.file, 'utf-8')
        this.lastReadContent = raw
        const text = raw.replace(/^\uFEFF/, '')
        const data = JSON.parse(text)
        if (Array.isArray(data)) {
          const seenKeys = new Set<string>()
          const cleaned: HistoryEntry[] = []
          for (const item of data) {
            const e = item as Record<string, unknown>
            // 1) Validate status (legacy 'Completed'/'Failed' -> lowercase).
            const status: HistoryStatus | null = normalizeHistoryStatus(e.status)
            if (!status) continue
            // 2) Drop records with no real file name ("Untitled"/"Unknown"/empty).
            if (typeof e.fileName !== 'string' || !hasRealFileName(e.fileName)) continue
            // 3) Completed records must point at an actual file path.
            if (status === 'completed' && (typeof e.path !== 'string' || e.path.length === 0)) continue
            // 4) Deduplicate by uniqueKey (keep the first = newest occurrence).
            const uniqueKey = typeof e.uniqueKey === 'string' ? e.uniqueKey : undefined
            if (uniqueKey) {
              if (seenKeys.has(uniqueKey)) continue
              seenKeys.add(uniqueKey)
            }
            cleaned.push({
              id: typeof e.id === 'string' ? e.id : randomUUID(),
              uniqueKey,
              fileName: String(e.fileName),
              date: Number(e.date) || Date.now(),
              type: e.type === 'audio' ? 'audio' : e.type === 'image' ? 'image' : 'video',
              size: Number(e.size) || 0,
              status,
              path: typeof e.path === 'string' ? e.path : '',
              url: typeof e.url === 'string' ? e.url : '',
              source: e.source === 'converter' ? 'converter' : 'download',
              playlistId: typeof e.playlistId === 'string' ? e.playlistId : undefined,
              playlistTitle: typeof e.playlistTitle === 'string' ? e.playlistTitle : undefined,
              playlistIndex: Number(e.playlistIndex) || undefined,
              playlistCount: Number(e.playlistCount) || undefined
            })
          }
          cleaned.sort((a, b) => b.date - a.date)
          this.entries = cleaned
          this.trim()
          // Rewrite the cleaned list so invalid records are removed from disk too.
          this.persist()
        } else {
          this.entries = []
        }
      } else {
        this.lastReadContent = null
        this.entries = []
      }
    } catch (e) {
      // Corrupt file: treat as empty for the UI but keep lastReadContent as the
      // actual raw text so sync won't reload (and recurse) on every call, and
      // recovery happens automatically once the file becomes valid again.
      logger.error(`history load failed: ${e}`)
      this.entries = []
    }
  }

  /**
   * The JSON file is the single source of truth. If its content changed outside
   * of this manager (edited/deleted on disk while the app is running), reload it
   * before every read/write so the UI can never show stale in-memory data.
   * Content (not mtime) is compared, so back-to-back writes within the same
   * filesystem timestamp tick are still detected reliably.
   */
  private syncFromDiskIfChanged(): void {
    try {
      const current = existsSync(this.file) ? readFileSync(this.file, 'utf-8') : null
      if (current !== this.lastReadContent) {
        this.load()
        this.emit()
      }
    } catch (e) {
      logger.error(`history sync failed: ${e}`)
    }
  }

  private persist(): void {
    try {
      const text = JSON.stringify(this.entries, null, 2)
      writeFileSync(this.file, text, 'utf-8')
      this.lastReadContent = text
    } catch (e) {
      logger.error(`history save failed: ${e}`)
    }
  }

  /** Cap the list at MAX_ENTRIES while never evicting live (active) records. */
  private trim(): void {
    if (this.entries.length <= MAX_ENTRIES) return
    const active = this.entries.filter((e) => ACTIVE_STATUSES.has(e.status))
    const terminal = this.entries.filter((e) => !ACTIVE_STATUSES.has(e.status))
    const budget = Math.max(0, MAX_ENTRIES - active.length)
    this.entries = [...active, ...terminal.slice(0, budget)]
  }

  add(entry: NewEntry): HistoryEntry {
    this.syncFromDiskIfChanged()
    const full: HistoryEntry = {
      ...entry,
      id: entry.id ?? randomUUID(),
      date: entry.date ?? Date.now()
    }
    if (full.uniqueKey) {
      this.entries = this.entries.filter((e) => e.uniqueKey !== full.uniqueKey)
    }
    this.entries.unshift(full)
    this.trim()
    this.persist()
    this.emit()
    return full
  }

  /**
   * Insert a record or update the existing record that shares `uniqueKey`,
   * keeping one history row per download job across its whole lifecycle
   * (queued -> analyzing -> ... -> completed/failed/cancelled). The id and
   * original date are preserved so deletes and ordering stay stable.
   */
  upsert(entry: NewEntry): HistoryEntry {
    this.syncFromDiskIfChanged()
    const existingIdx = entry.uniqueKey ? this.entries.findIndex((e) => e.uniqueKey === entry.uniqueKey) : -1
    const existing = existingIdx >= 0 ? this.entries[existingIdx] : undefined
    const full: HistoryEntry = {
      ...entry,
      id: entry.id ?? existing?.id ?? randomUUID(),
      date: entry.date ?? existing?.date ?? Date.now()
    }
    if (existing) {
      this.entries[existingIdx] = full
    } else {
      this.entries.unshift(full)
      this.trim()
    }
    this.persist()
    this.emit()
    return full
  }

  list(): HistoryEntry[] {
    this.syncFromDiskIfChanged()
    return [...this.entries]
  }

  clear(): void {
    this.syncFromDiskIfChanged()
    this.entries = []
    this.persist()
    this.emit()
  }

  /** Remove a single entry by id. Returns true when an entry was actually removed. */
  remove(id: string): boolean {
    this.syncFromDiskIfChanged()
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    const removed = this.entries.length !== before
    if (removed) {
      this.persist()
      this.emit()
    }
    return removed
  }

  onChange(cb: (entries: HistoryEntry[]) => void): void {
    this.listeners.push(cb)
  }

  private emit(): void {
    const snapshot = this.list()
    for (const cb of this.listeners) {
      try {
        cb(snapshot)
      } catch (e) {
        logger.error(`history listener error: ${e}`)
      }
    }
  }
}
