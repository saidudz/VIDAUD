// copy-release.mjs
// Copies the final production artifacts produced by electron-builder in dist/
// into release/ so end users have one obvious folder to grab:
//   - VIDAUD Setup.exe        (NSIS installer for distribution)
//   - VIDAUD.exe              (portable, no-install executable)
//   - latest.yml / blockmap   (auto-update metadata, kept for future use)
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const release = join(root, 'release')

if (!existsSync(dist)) {
  console.error('[release] dist/ not found - run npm run dist first.')
  process.exit(1)
}

mkdirSync(release, { recursive: true })

const wanted = new Set(['.exe', '.yml', '.blockmap', '.json'])
let copied = 0
for (const name of readdirSync(dist)) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (!wanted.has(ext)) continue
  const from = join(dist, name)
  const to = join(release, name)
  copyFileSync(from, to)
  copied += 1
  console.log(`[release] ${name}`)
}

if (copied === 0) {
  console.error('[release] no artifacts found in dist/')
  process.exit(1)
}

console.log(`[release] ${copied} artifact(s) copied to release/`)
