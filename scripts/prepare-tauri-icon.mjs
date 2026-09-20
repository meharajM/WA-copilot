import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const SIZE = 512
const BACKGROUND = [35, 79, 153, 255]
const FOREGROUND = [255, 255, 255, 255]
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function placeholderPng() {
  const rowLength = SIZE * 4 + 1
  const pixels = Buffer.alloc(rowLength * SIZE)

  for (let y = 0; y < SIZE; y += 1) {
    const row = y * rowLength
    pixels[row] = 0 // PNG filter: None

    for (let x = 0; x < SIZE; x += 1) {
      const distanceFromCenter = Math.abs(x - SIZE / 2)
      const halfGlyphWidth = (y - 88) * 0.52
      const glyph = y >= 88 && y <= 424 && (
        Math.abs(distanceFromCenter - halfGlyphWidth) <= 24
        || (y >= 280 && y <= 320 && distanceFromCenter <= 125)
      )
      const color = glyph ? FOREGROUND : BACKGROUND
      const offset = row + 1 + x * 4
      pixels.set(color, offset)
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconPath = join(projectRoot, 'src-tauri', 'icons', 'icon.png')
await mkdir(dirname(iconPath), { recursive: true })
const icon = placeholderPng()
let iconIsCurrent = false
try {
  iconIsCurrent = (await readFile(iconPath)).equals(icon)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (!iconIsCurrent) await writeFile(iconPath, icon)
