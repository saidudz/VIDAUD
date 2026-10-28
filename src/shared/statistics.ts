import type { HistoryEntry, HistoryStatus, StatsSummary } from './types'

/**
 * Statuses that count toward the Dashboard/Header "Active" number. Paused and
 * terminal statuses (completed/failed/cancelled/unavailable) never count.
 */
export const ACTIVE_STATUSES: ReadonlySet<HistoryStatus> = new Set([
  'queued',
  'analyzing',
  'downloading',
  'processing',
  'converting',
  'retrying'
])

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'analyzing',
  'downloading',
  'processing',
  'converting',
  'retrying',
  'completed',
  'failed',
  'cancelled',
  'unavailable'
])

/**
 * Normalize a persisted/legacy status into the canonical lowercase value.
 * Legacy values ('Completed'/'Failed') and legacy 'Waiting' are mapped;
 * anything else invalid returns null so callers can drop the record.
 */
export function normalizeHistoryStatus(value: unknown): HistoryStatus | null {
  if (typeof value !== 'string') return null
  const lower = value.toLowerCase()
  if (lower === 'waiting') return 'queued'
  return VALID_STATUSES.has(lower) ? (lower as HistoryStatus) : null
}

export function isActiveStatus(status: HistoryStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

/**
 * Single source of truth for the Dashboard/Header statistics: everything is
 * derived from the History Store, never from separate counters.
 */
export function calculateStatistics(entries: HistoryEntry[]): StatsSummary {
  let active = 0
  let completed = 0
  let failed = 0
  let totalBytes = 0
  for (const e of entries) {
    const status = e.status
    if (ACTIVE_STATUSES.has(status)) {
      active += 1
    } else if (status === 'completed') {
      completed += 1
      totalBytes += Number(e.size) || 0
    } else if (status === 'failed') {
      failed += 1
    }
  }
  return { active, completed, failed, totalBytes }
}
