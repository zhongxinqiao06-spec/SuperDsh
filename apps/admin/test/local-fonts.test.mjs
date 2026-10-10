import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../src/app/fonts/', import.meta.url)

test('bundled font files match their recorded distributions and retain licenses', async () => {
  const { fonts } = JSON.parse(
    await readFile(new URL('sources.json', root), 'utf8'),
  )
  for (const font of fonts) {
    const license = await readFile(new URL(font.licenseFile, root), 'utf8')
    assert.match(license, /SIL OPEN FONT LICENSE/)
    for (const asset of font.assets) {
      const bytes = await readFile(new URL(asset.path, root))
      assert.equal(bytes.subarray(0, 4).toString(), 'wOF2')
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        asset.sha256,
      )
    }
  }
})
