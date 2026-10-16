/** Derive owned Web brand assets from the Starbridge SVG without native toolchains. */
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const sharp = require('sharp')
const publicRoot = join(root, 'apps/admin/public')
const source = await readFile(join(publicRoot, 'brand/starbridge-mark.svg'))
const check = process.argv.includes('--check')
const background = '#0a0d0c'
let count = 0

async function output(path, bytes) {
  if (check) {
    const current = await readFile(path).catch(() => null)
    if (!current?.equals(bytes))
      throw new Error(
        `${path}: stale brand asset; run node scripts/export-web-icons.mjs`,
      )
  } else await writeFile(path, bytes)
  count++
}

async function png(size, safeArea = false) {
  const artworkSize = safeArea ? Math.round(size * 0.8) : size
  const artwork = await sharp(source)
    .resize(artworkSize, artworkSize)
    .png({ compressionLevel: 9 })
    .toBuffer()
  if (!safeArea) return artwork
  return sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([{ input: artwork, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

for (const [size, names] of [
  [32, ['icon-dark-32x32.png', 'icon-light-32x32.png']],
  [64, ['favicon-dark-mode.png', 'favicon-light-mode.png']],
  [180, ['apple-icon.png', 'apple-touch-icon.png']],
  [192, ['icon-192.png']],
  [
    512,
    [
      'icon-512.png',
      'brand/aa-logo-dark-mode.png',
      'brand/aa-logo-light-mode.png',
    ],
  ],
]) {
  const bytes = await png(size)
  for (const name of names) await output(join(publicRoot, name), bytes)
}

for (const size of [192, 512])
  await output(
    join(publicRoot, `icon-maskable-${size}.png`),
    await png(size, true),
  )

for (const path of [
  join(publicRoot, 'icon.svg'),
  join(root, 'apps/desktop/ui/public/favicon.svg'),
  join(root, 'apps/desktop/ui/public/favicon-dark.svg'),
])
  await output(path, source)

// Native onboarding consumes a monochrome alpha mask at its established asset path.
const mask = source.toString('utf8').replace(/ {2}<rect[^>]+\/>\r?\n/, '')
await output(
  join(root, 'apps/desktop/ui/src/app/native/assets/DeepSeek.svg'),
  Buffer.from(mask),
)

// Keep established Electron filenames and scale suffixes for automatic DPI loading.
for (const [size, suffix] of [
  [16, ''],
  [20, '@1.25x'],
  [24, '@1.5x'],
  [32, '@2x'],
])
  await output(
    join(root, `apps/desktop/assets/tray-icon-blue${suffix}.png`),
    await png(size),
  )
for (const [size, suffix] of [
  [16, ''],
  [32, '@2x'],
])
  await output(
    join(root, `apps/desktop/assets/tray-iconTemplate${suffix}.png`),
    await sharp(Buffer.from(mask.replaceAll('#c4f76b', '#000000')))
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  )

// PNG-encoded ICO frames preserve crisp browser favicons at common display scales.
const sizes = [16, 32, 48, 64, 256]
const frames = await Promise.all(sizes.map((size) => png(size)))
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16
  header[entry] = size === 256 ? 0 : size
  header[entry + 1] = size === 256 ? 0 : size
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(frames[index].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += frames[index].length
}
await output(
  join(publicRoot, 'favicon.ico'),
  Buffer.concat([header, ...frames]),
)
console.log(
  `Starbridge: ${check ? 'verified' : 'exported'} ${count} Web brand assets`,
)
