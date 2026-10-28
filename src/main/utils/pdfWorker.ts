import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Locate the bundled pdfjs worker module on disk. It is shipped inside the
 * app (`resources/pdf/pdf.worker.mjs`) so pdfjs can dynamically `import()`
 * it at runtime:
 *  - packaged:   <install>/resources/pdf/pdf.worker.mjs (extraResources)
 *  - dev/build:  <project>/resources/pdf/pdf.worker.mjs
 * Falls back to the node_modules copy (installed by npm) for robustness.
 */
export function resolvePdfWorkerPath(): string | null {
  const candidates = [
    join(process.resourcesPath, 'pdf', 'pdf.worker.mjs'),
    join(app.getAppPath(), 'resources', 'pdf', 'pdf.worker.mjs'),
    join(app.getAppPath(), 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs')
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** file:// URL of the pdfjs worker, consumed by GlobalWorkerOptions.workerSrc. */
export function resolvePdfWorkerUrl(): string | null {
  const p = resolvePdfWorkerPath()
  return p ? pathToFileURL(p).href : null
}
