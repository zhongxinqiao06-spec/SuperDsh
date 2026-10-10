/** Keep platform selections session-local in the checksum-verified pinned runtime. */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '0.1.7-alpha.2'
const packageName = '@deepseek-ai/dsh-api-session-controller'
const vendor = join(root, 'vendor/dsh-runtime', version)
const manifest = JSON.parse(readFileSync(join(vendor, 'manifest.json'), 'utf8'))
const entry = manifest.packages.find((item) => item.name === packageName)
if (manifest.version !== version || entry?.version !== version)
  throw new Error(
    'Review the product model-selection patch for the new runtime',
  )
const archive = join(vendor, entry.filename)
if (
  createHash('sha256').update(readFileSync(archive)).digest('hex') !==
  entry.sha256
)
  throw new Error('Pinned session-controller archive checksum mismatch')
const temporary = mkdtempSync(join(tmpdir(), 'superdsh-model-selection-patch-'))
const patch = join(root, `patches/dsh-api-session-controller@${version}.patch`)
try {
  for (const target of ['pristine', 'product']) {
    mkdirSync(join(temporary, target))
    execFileSync('tar', ['-xzf', archive, '-C', join(temporary, target)], {
      windowsHide: true,
    })
  }
  const product = join(temporary, 'product/package')
  // Preserve all earlier behavior when this patch gains another reviewed change.
  if (existsSync(patch))
    execFileSync('git', ['apply', '--unsafe-paths', '--unidiff-zero', patch], {
      cwd: product,
      windowsHide: true,
    })
  const allowedFiles = ['lib/index.js', 'lib/types/commands.js']
  for (const file of allowedFiles) {
    const path = join(product, file)
    let source = readFileSync(path, 'utf8')
    const needle = 'await this.ctx.agentDefaultModel.saveSelection(selected);'
    const guard = '!/^superdsh-[a-f0-9]{64}-/.test(selected.provider)'
    if (!source.includes(guard)) {
      if (source.split(needle).length !== 2)
        throw new Error(`Pinned model selection layout changed: ${file}`)
      source = source.replace(needle, `if (${guard}) ${needle}`)
    }
    writeFileSync(path, source)
  }
  const diff = spawnSync(
    'git',
    ['diff', '--no-index', '--', 'pristine/package', 'product/package'],
    { cwd: temporary, encoding: 'utf8', windowsHide: true },
  )
  if (![0, 1].includes(diff.status)) throw new Error(diff.stderr)
  const output = diff.stdout
    .replaceAll('a/pristine/package/', 'a/')
    .replaceAll('b/product/package/', 'b/')
  const files = [...output.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)]
  if (
    files.length !== allowedFiles.length ||
    files.some(
      (match) => match[1] !== match[2] || !allowedFiles.includes(match[1]),
    )
  )
    throw new Error(
      'The product model-selection patch exceeds its file allowlist',
    )
  if (process.argv.includes('--check')) {
    if (readFileSync(patch, 'utf8').replaceAll('\r\n', '\n') !== output)
      throw new Error('Product model-selection patch is not reproducible')
  } else writeFileSync(patch, output)
  console.log('Pinned product model-selection patch verified')
} finally {
  const inside = relative(resolve(tmpdir()), resolve(temporary))
  if (
    !inside.startsWith('..') &&
    inside.startsWith('superdsh-model-selection-patch-')
  )
    rmSync(temporary, { recursive: true, force: true })
}
