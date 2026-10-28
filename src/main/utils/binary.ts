import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { logger } from './logger'

export function resolveBinary(name: 'yt-dlp.exe' | 'ffmpeg.exe'): string | null {
  let candidates: string[] = []
  if (app.isPackaged) {
    candidates = [join(process.resourcesPath, 'bin', name)]
  } else {
    candidates = [
      join(app.getAppPath(), 'resources', 'bin', name),
      join(app.getAppPath(), 'out', 'resources', 'bin', name)
    ]
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  logger.warn(`binary not found: ${name} (checked ${candidates.join(', ')})`)
  return null
}
