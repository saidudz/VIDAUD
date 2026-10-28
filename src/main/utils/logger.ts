import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

let logFile: ReturnType<typeof createWriteStream> | null = null
let initialized = false

function ensureLogFile(): void {
  if (initialized) return
  initialized = true
  try {
    const dir = join(app.getPath('userData'), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    logFile = createWriteStream(join(dir, `vidaud-${stamp}.log`), { flags: 'a' })
    // keep only the 5 most recent logs
    const { readdirSync, unlinkSync } = require('node:fs') as typeof import('node:fs')
    const logs = readdirSync(dir).filter((f) => f.startsWith('vidaud-') && f.endsWith('.log')).sort()
    while (logs.length > 5) {
      const old = logs.shift()!
      try {
        unlinkSync(join(dir, old))
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    logFile = null
    console.error('[logger] failed to init file logging', e)
  }
}

function write(level: LogLevel, msg: string): void {
  ensureLogFile()
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`
  if (logFile) {
    try {
      logFile.write(line + '\n')
    } catch {
      /* ignore */
    }
  }
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  debug: (msg: string): void => write('debug', msg),
  info: (msg: string): void => write('info', msg),
  warn: (msg: string): void => write('warn', msg),
  error: (msg: string): void => write('error', msg)
}
