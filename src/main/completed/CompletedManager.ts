import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { CompletedItem } from '@shared/types'
import { hasRealFileName, hasRealTitle } from '../utils/title'
import { logger } from '../utils/logger'

const MAX_ITEMS = 5000

export class CompletedManager {
  private items: CompletedItem[] = []
  private file: string
  private listeners: Array<(items: CompletedItem[]) => void> = []

  constructor() {
    const userData = app.getPath('userData')
    if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
    this.file = join(userData, 'completed.json')
    logger.info(`[VIDAUD][COMPLETED] Storage: ${this.file}`)
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown[]
        if (Array.isArray(data)) {
          this.items = data
            .filter((e) => e && typeof (e as CompletedItem).filePath === 'string' && (e as CompletedItem).filePath.length > 0)
            // Startup cleanup: records that were never really downloaded (no
            // real title / placeholder names like "21 - Untitled") are dropped
            // so they can never appear in the Completed library. Files on disk
            // are never touched.
            .filter((e) => {
              const it = e as Partial<CompletedItem>
              const title = typeof it.title === 'string' && it.title.trim() ? it.title : (String(it.fileName ?? '') || String(it.filePath ?? '').split(/[\\/]/).pop() || '')
              return hasRealTitle(title) && hasRealFileName(String(it.fileName ?? '') || String(it.filePath ?? '').split(/[\\/]/).pop() || '')
            })
            .slice(0, MAX_ITEMS)
            .map((e) => {
              const it = e as Partial<CompletedItem>
              const filePath = String(it.filePath)
              const fileName = typeof it.fileName === 'string' && it.fileName ? it.fileName : (filePath.split(/[\\/]/).filter(Boolean).pop() ?? '')
              return {
                id: typeof it.id === 'string' && it.id ? it.id : randomUUID(),
                title: typeof it.title === 'string' && it.title ? it.title : fileName,
                filePath,
                fileName,
                format: typeof it.format === 'string' && it.format ? it.format : 'unknown',
                type: it.type === 'audio' ? 'audio' : it.type === 'image' ? 'image' : 'video',
                size: Number(it.size) || 0,
                completedAt: Number(it.completedAt) || Date.now(),
                thumbnail: typeof it.thumbnail === 'string' ? it.thumbnail : undefined,
                quality: typeof it.quality === 'string' ? it.quality : undefined,
                sourceUrl: typeof it.sourceUrl === 'string' ? it.sourceUrl : undefined,
                source: it.source === 'converter' ? 'converter' : 'download',
                originalFormat: typeof it.originalFormat === 'string' && it.originalFormat ? it.originalFormat : undefined,
                playlistId: typeof it.playlistId === 'string' ? it.playlistId : undefined,
                playlistTitle: typeof it.playlistTitle === 'string' ? it.playlistTitle : undefined,
                playlistIndex: Number(it.playlistIndex) || undefined
              }
            })
        } else {
          this.items = []
        }
      }
    } catch (e) {
      logger.error(`completed load failed: ${e}`)
      this.items = []
    }
  }

  /** Add a completed file record. Deduplicated by filePath (and id): an entry
   *  for the same file replaces the previous one so re-downloads never create
   *  duplicate rows. Records without a real title are refused: only genuinely
   *  downloaded/converted files appear in the Completed library. */
  add(input: Omit<CompletedItem, 'id' | 'completedAt'> & { id?: string; completedAt?: number }): CompletedItem {
    const fileName = input.fileName || input.filePath.split(/[\\/]/).pop() || input.title
    const item: CompletedItem = {
      ...input,
      fileName,
      id: input.id ?? randomUUID(),
      completedAt: input.completedAt ?? Date.now()
    }
    if (!hasRealTitle(input.title || fileName) || !hasRealFileName(fileName)) {
      logger.warn(`[VIDAUD][COMPLETED] Refusing to register item with no real title: ${fileName}`)
      return item
    }
    const dup = this.items.find((i) => i.filePath.toLowerCase() === item.filePath.toLowerCase())
    if (dup) {
      this.items = this.items.filter((i) => i.id !== dup.id)
    }
    this.items.unshift(item)
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(0, MAX_ITEMS)
    this.persist()
    this.emit()
    return item
  }

  /** Update the file path of a completed item (e.g. when relocated by the user). */
  updateFilePath(id: string, newPath: string): boolean {
    const item = this.items.find((i) => i.id === id)
    if (!item) return false
    item.filePath = newPath
    item.fileName = newPath.split(/[\\/]/).pop() ?? item.title
    item.exists = existsSync(newPath)
    this.persist()
    this.emit()
    return true
  }

  list(): CompletedItem[] {
    // Annotate each record with whether the underlying file still exists.
    return this.items.map((i) => ({ ...i, exists: existsSync(i.filePath) }))
  }

  /** Remove a record only — the file on disk is untouched. */
  remove(id: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((i) => i.id !== id)
    const removed = this.items.length !== before
    if (removed) {
      this.persist()
      this.emit()
    }
    return removed
  }

  /** Remove records whose underlying file no longer exists. Returns count removed. */
  removeMissing(): number {
    const before = this.items.length
    this.items = this.items.filter((i) => existsSync(i.filePath))
    const removed = before - this.items.length
    if (removed > 0) {
      this.persist()
      this.emit()
    }
    return removed
  }

  /** Clear every record in the Completed library. RECORDS ONLY — the files on
   *  disk are never touched, and History/Downloads are never modified. Returns
   *  the number of records removed. Persists and notifies listeners so the UI
   *  refreshes immediately. */
  clearAll(): number {
    const before = this.items.length
    if (before === 0) return 0
    this.items = []
    this.persist()
    this.emit()
    return before
  }

  /** Remove the record AND delete the real file from disk. Returns true when
   *  the record was removed (regardless of whether the file existed). */
  deleteFile(id: string): { removed: boolean; fileDeleted: boolean } {
    const found = this.items.find((i) => i.id === id)
    if (!found) return { removed: false, fileDeleted: false }
    let fileDeleted = false
    if (existsSync(found.filePath)) {
      try {
        rmSync(found.filePath, { force: true })
        fileDeleted = true
      } catch (e) {
        logger.warn(`[VIDAUD][COMPLETED] delete file failed: ${e}`)
        fileDeleted = false
      }
    }
    const removed = this.remove(id)
    return { removed, fileDeleted }
  }

  onChange(cb: (items: CompletedItem[]) => void): void {
    this.listeners.push(cb)
  }

  private persist(): void {
    try {
      const text = JSON.stringify(this.items, null, 2)
      writeFileSync(this.file, text, 'utf-8')
    } catch (e) {
      logger.error(`completed save failed: ${e}`)
    }
  }

  private emit(): void {
    const snapshot = this.list()
    for (const cb of this.listeners) {
      try {
        cb(snapshot)
      } catch (e) {
        logger.error(`completed listener error: ${e}`)
      }
    }
  }
}
