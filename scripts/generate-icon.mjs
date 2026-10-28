// Generates resources/icon.ico (multi-resolution) and resources/icon.png from
// the brand logo file (default: C:\Users\SAIDU\Downloads\Logo.png).
// Pure Node — only uses zlib. ICO contains PNG-compressed frames for 16..256px
// so Windows picks a sharp frame at every size (taskbar, title bar, desktop).
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'resources')
const logoPath = process.env['VIDAUD_LOGO'] || 'C:\\Users\\SAIDU\\Downloads\\Logo.png'

if (!existsSync(logoPath)) {
  console.error(`[icon] logo not found: ${logoPath}`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

// ---------- PNG encoder ----------
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ---------- PNG decoder (8-bit, color types 0/2/4/6) ----------
function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (!width || !height) throw new Error('invalid PNG')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : -1
  if (channels < 0) throw new Error(`unsupported PNG color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let val = row[x]
      switch (filter) {
        case 1:
          val += a
          break
        case 2:
          val += b
          break
        case 3:
          val += (a + b) >> 1
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          val += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
      }
      cur[x] = val & 0xff
    }
    const oy = y * width * 4
    for (let x = 0; x < width; x++) {
      const o = oy + x * 4
      if (colorType === 6) {
        out[o] = cur[x * 4]
        out[o + 1] = cur[x * 4 + 1]
        out[o + 2] = cur[x * 4 + 2]
        out[o + 3] = cur[x * 4 + 3]
      } else if (colorType === 2) {
        out[o] = cur[x * 3]
        out[o + 1] = cur[x * 3 + 1]
        out[o + 2] = cur[x * 3 + 2]
        out[o + 3] = 255
      } else if (colorType === 0) {
        const v = cur[x]
        out[o] = v
        out[o + 1] = v
        out[o + 2] = v
        out[o + 3] = 255
      } else {
        const v = cur[x * 2]
        out[o] = v
        out[o + 1] = v
        out[o + 2] = v
        out[o + 3] = cur[x * 2 + 1]
      }
    }
    prev = cur
  }
  return { width, height, rgba: out }
}

// ---------- high-quality box resampler (premultiplied-alpha aware) ----------
function resize(srcW, srcH, src, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4)
  const xScale = srcW / dstW
  const yScale = srcH / dstH
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = dy * yScale
    const sy1 = Math.min(srcH, (dy + 1) * yScale)
    const iy0 = Math.floor(sy0)
    const iy1 = Math.min(srcH, Math.floor(sy1 + 1e-9) + 1)
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = dx * xScale
      const sx1 = Math.min(srcW, (dx + 1) * xScale)
      const ix0 = Math.floor(sx0)
      const ix1 = Math.min(srcW, Math.floor(sx1 + 1e-9) + 1)
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let y = iy0; y < iy1; y++) {
        const wy = Math.max(0, Math.min(1, Math.min(sy1, y + 1) - Math.max(sy0, y)))
        const oy = y * srcW * 4
        for (let x = ix0; x < ix1; x++) {
          const wx = Math.max(0, Math.min(1, Math.min(sx1, x + 1) - Math.max(sx0, x)))
          const w = wx * wy
          const o = oy + x * 4
          const al = src[o + 3] / 255
          r += src[o] * al * w
          g += src[o + 1] * al * w
          b += src[o + 2] * al * w
          a += al * w
        }
      }
      const o = (dy * dstW + dx) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(Math.min(1, a) * 255)
    }
  }
  return out
}

// ---------- build ----------
const src = decodePng(readFileSync(logoPath))
const SIZES = [16, 24, 32, 48, 64, 128, 256]

function makeIco(frames) {
  const count = frames.length
  const dirLen = 6 + 16 * count
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  const parts = [header]
  let offset = dirLen
  for (const f of frames) {
    const e = Buffer.alloc(16)
    e[0] = f.size >= 256 ? 0 : f.size
    e[1] = f.size >= 256 ? 0 : f.size
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(f.png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += f.png.length
    parts.push(e)
  }
  for (const f of frames) parts.push(f.png)
  return Buffer.concat(parts)
}

const frames = []
for (const s of SIZES) {
  const rgba = s === src.width && s === src.height ? src.rgba : resize(src.width, src.height, src.rgba, s, s)
  frames.push({ size: s, png: encodePng(s, s, rgba) })
}

writeFileSync(join(outDir, 'icon.ico'), makeIco(frames))
const master = frames.find((f) => f.size === 256)
writeFileSync(join(outDir, 'icon.png'), master.png)
console.log(`[icon] generated resources/icon.ico (${SIZES.join(',')}px, ${(makeIco(frames).length / 1024).toFixed(0)} KB) and resources/icon.png from ${logoPath}`)
