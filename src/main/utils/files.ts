import { statSync, existsSync } from 'node:fs'
import { basename, join, parse } from 'node:path'
import { sanitizeFolderName } from '@shared/paths'

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const MAX_NAME_LENGTH = 160

export function sanitizeFilename(input: string, fallback = 'download'): string {
  let name = (input || '').trim()
  name = name.replace(INVALID_CHARS, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '')
  // allow unicode / RTL chars but strip control chars
  if (name.length === 0) name = fallback
  if (RESERVED_NAMES.test(name)) name = `_${name}`
  const ext = parse(name).ext
  const base = name.slice(0, name.length - ext.length)
  const maxBase = MAX_NAME_LENGTH - ext.length
  const trimmed = base.length > maxBase ? base.slice(0, maxBase).trim() : base
  return (trimmed || fallback) + ext
}

/**
 * Filename guard used when the user disables "Sanitize filenames": keeps the
 * original spacing and characters, but still strips what Windows itself
 * rejects (control chars, reserved chars, trailing dots) so the file is
 * always written to disk without errors.
 */
export function minimalSafeName(input: string, fallback = 'download'): string {
  let name = (input || '').trim()
  name = name.replace(INVALID_CHARS, ' ').replace(/[. ]+$/g, '')
  if (name.length === 0) name = fallback
  if (RESERVED_NAMES.test(name)) name = `_${name}`
  return name
}

export interface NameStrategy {
  action: 'rename' | 'replace' | 'skip'
}

export function resolveFinalPath(dir: string, filename: string, strategy: NameStrategy, sanitize = true): { path: string; action: 'rename' | 'replace' | 'skip' } {
  const clean = sanitize ? sanitizeFilename(filename) : minimalSafeName(filename)
  const target = join(dir, clean)
  if (!existsSync(target)) return { path: target, action: 'rename' }
  if (strategy.action === 'replace') return { path: target, action: 'replace' }
  if (strategy.action === 'skip') return { path: target, action: 'skip' }
  // rename: Title (1).ext, Title (2).ext ...
  const { name, ext } = parse(clean)
  let i = 1
  let candidate = join(dir, `${name} (${i})${ext}`)
  while (existsSync(candidate)) {
    i += 1
    candidate = join(dir, `${name} (${i})${ext}`)
  }
  return { path: candidate, action: 'rename' }
}

/** Windows-safe folder name derived from a playlist title. */
export function playlistFolderName(title: string): string {
  return sanitizeFolderName(title, 'Playlist')
}

/**
 * Resolve the destination folder for a playlist download under `baseDir`.
 * - mode `use-existing`: reuse the existing folder when present.
 * - mode `new-numbered`: create `Name (2)`, `Name (3)`, ... when taken.
 */
export function resolvePlaylistFolderPath(baseDir: string, title: string, mode: 'use-existing' | 'new-numbered'): { path: string; mode: 'created' | 'existing' | 'new' } {
  const name = playlistFolderName(title)
  const base = join(baseDir, name)
  if (!existsSync(base)) return { path: base, mode: 'created' }
  if (mode === 'use-existing') return { path: base, mode: 'existing' }
  let i = 2
  let candidate = join(baseDir, `${name} (${i})`)
  while (existsSync(candidate)) {
    i += 1
    candidate = join(baseDir, `${name} (${i})`)
  }
  return { path: candidate, mode: 'new' }
}

export function fileSizeBytes(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

export function fileExists(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).size > 0
  } catch {
    return false
  }
}

export function friendlySize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / Math.pow(1024, i)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function isSameFile(a: string, b: string): boolean {
  return basename(a) === basename(b) && a.toLowerCase() === b.toLowerCase()
}
