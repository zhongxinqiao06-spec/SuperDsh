import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const revision = '523d033d6cb47f4a80c58a35753646f5c3608a78'
const base = `https://raw.githubusercontent.com/notofonts/noto-cjk/${revision}/`
const files = [
  [
    'NotoSansCJKsc-Regular.otf',
    'Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
    '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
  ],
  [
    'NotoSansCJKsc-Bold.otf',
    'Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf',
    'b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a',
  ],
  [
    'LICENSE.txt',
    'LICENSE',
    '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2',
  ],
]
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export async function prepareOfficeFonts(
  root = fileURLToPath(
    new URL('../apps/admin/.office-fonts/', import.meta.url),
  ),
) {
  await mkdir(root, { recursive: true })
  for (const [name, path, expected] of files) {
    const destination = join(root, name)
    if (
      await readFile(destination).then(
        (bytes) => digest(bytes) === expected,
        () => false,
      )
    )
      continue
    console.log(`Preparing document font: ${name}`)
    const response = await fetch(base + path, {
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok || !response.body)
      throw new Error(`Font download failed: ${response.status}`)
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > 24 * 1024 * 1024) throw new Error('Font exceeds size limit')
      chunks.push(Buffer.from(chunk))
    }
    const bytes = Buffer.concat(chunks)
    if (digest(bytes) !== expected)
      throw new Error(`Pinned font checksum mismatch: ${name}`)
    const temporary = join(root, '.' + name + '.' + randomUUID())
    try {
      await writeFile(temporary, bytes, { flag: 'wx' })
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await prepareOfficeFonts(process.argv[2])
