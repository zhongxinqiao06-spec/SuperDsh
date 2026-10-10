/** Regenerate the product bridge patch against the checksum-verified pinned archive. */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const provenance = JSON.parse(
  readFileSync(join(root, 'vendor/agents-anywhere/provenance.json'), 'utf8'),
)
const archive = join(root, 'vendor/agents-anywhere', provenance.artifact)
if (
  createHash('sha256').update(readFileSync(archive)).digest('hex') !==
  provenance.sha256
)
  throw new Error('Pinned AA archive checksum mismatch')
const temporary = mkdtempSync(join(tmpdir(), 'superdsh-bridge-patch-'))
const patch = join(root, 'patches/agents-anywhere-connector-httpx.patch')
try {
  for (const target of ['pristine', 'product']) {
    mkdirSync(join(temporary, target))
    execFileSync('tar', ['-xzf', archive, '-C', join(temporary, target)], {
      windowsHide: true,
    })
  }
  const product = join(temporary, 'product/package')
  // Reapply the complete existing patch first; never lose previous compatibility fixes.
  execFileSync('git', ['apply', '--unsafe-paths', '--unidiff-zero', patch], {
    cwd: product,
    windowsHide: true,
  })
  const jsFile = join(product, 'lib/index.js')
  let js = readFileSync(jsFile, 'utf8')
  const managedGuard =
    'if (process.env.SUPERDSH_PLATFORM_MANAGED === "1") return;'
  if (!js.includes(managedGuard))
    js = js.replace(
      'function apply(ctx, config) {',
      `function apply(ctx, config) {\n\t${managedGuard}`,
    )
  if (!js.includes('function applyRuntime('))
    js = js.replace(
      'export { Config, apply, name };',
      'function applyRuntime(ctx, config) {\n\tctx.plugin(DshRuntimeService, config);\n}\nexport { Config, apply, applyRuntime, name };',
    )
  if (!js.includes('export { Config, apply, applyRuntime, name };'))
    throw new Error('Pinned bridge export layout changed')
  // Harness alpha.2 moved the Remote stream carrier to five arguments. Keep the
  // official in-process carrier so approvals/questions retain native lifetimes.
  const legacyStream =
    'ready.typertGateway.wireStream.open("$events", { args: {} }, abort.signal)'
  const productStream =
    'ready.typertGateway.wireStream.open("$events", { args: {} }, (async function* () {})(), undefined, abort.signal)'
  if (js.includes(legacyStream)) js = js.replace(legacyStream, productStream)
  if (!js.includes(productStream))
    throw new Error('Pinned bridge interaction stream layout changed')
  // New Host logs use a ToolMessage whose content contains ordinary blocks;
  // older logs put a tool-result block inside the message. Preserve both forms.
  const newline = js.includes('\r\n') ? '\r\n' : '\n'
  const productResult = [
    '\t\t\tconst message = record(event.data.message);',
    '\t\t\tconst source = record(message.source);',
    '\t\t\tconst nested = record(Array.isArray(message.content) ? message.content[0] : undefined);',
    '\t\t\tconst direct = nested.type !== "tool-result" && (message.role === "tool" || typeof message.toolCallId === "string" || source.kind === "tool");',
    '\t\t\tconst value = direct ? message : nested;',
    '\t\t\tconst callId = value.toolCallId ?? (direct ? source.callId : undefined);',
    '\t\t\tresult(callId, value.content, value.isError === true || Boolean(event.data.error), event, event.data.meta, event.data.error);',
  ].join(newline)
  const resultHead = 'else if (event.type === "tool/result") {' + newline
  const resultStart = js.indexOf(resultHead)
  const resultEnd = js.indexOf(
    '\t\t} else if (eventType === "tool/code-dispatch-start"',
    resultStart,
  )
  if (resultStart < 0 || resultEnd < 0)
    throw new Error('Pinned bridge tool result projection layout changed')
  const resultBody = js.slice(resultStart + resultHead.length, resultEnd)
  if (
    !resultBody.includes('const value = event.data.message.content[0];') &&
    !resultBody.includes('const message = record(event.data.message);')
  )
    throw new Error('Pinned bridge tool result projection body changed')
  js =
    js.slice(0, resultStart + resultHead.length) +
    productResult +
    newline +
    js.slice(resultEnd)
  if (!js.includes(productResult))
    throw new Error('Pinned bridge tool result projection layout changed')
  writeFileSync(jsFile, js)
  const typesFile = join(product, 'lib/index.d.ts')
  let types = readFileSync(typesFile, 'utf8')
  if (!types.includes('declare function applyRuntime('))
    types = types.replace(
      'export { Config, apply, name };',
      'declare function applyRuntime(ctx: Context, config: Config): void;\nexport { Config, apply, applyRuntime, name };',
    )
  writeFileSync(typesFile, types)
  const ownerFile = join(
    product,
    'lib/bundled-connector/connector/core/runtime_owner.py',
  )
  let owner = readFileSync(ownerFile, 'utf8')
  if (
    !owner.includes(
      '# SuperDsh: a byte lock avoids reserved Windows TCP ranges.',
    )
  ) {
    const needle =
      '    lease = _claim_state_lock(state_lock_port(path), time.monotonic() + timeout)'
    if (!owner.includes(needle))
      throw new Error('Pinned Connector state lock layout changed')
    owner = owner.replace(
      needle,
      String.raw`    # SuperDsh: a byte lock avoids reserved Windows TCP ranges.
    if sys.platform == "win32":
        import msvcrt

        with path.with_name(path.name + ".lock").open("a+b") as record:
            record.seek(0, 2)
            if record.tell() == 0:
                record.write(b"\0")
                record.flush()
            deadline = time.monotonic() + timeout
            while True:
                record.seek(0)
                try:
                    msvcrt.locking(record.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as exc:
                    if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                        raise
                    if time.monotonic() >= deadline:
                        raise RuntimeError("The local Connector record is busy. Please retry.") from exc
                    time.sleep(0.02)
            try:
                yield
            finally:
                record.seek(0)
                msvcrt.locking(record.fileno(), msvcrt.LK_UNLCK, 1)
        return
${needle}`,
    )
    writeFileSync(ownerFile, owner)
  }
  const diff = spawnSync(
    'git',
    ['diff', '--no-index', '--', 'pristine/package', 'product/package'],
    {
      cwd: temporary,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  )
  if (![0, 1].includes(diff.status)) throw new Error(diff.stderr)
  const output = diff.stdout
    .replaceAll('a/pristine/package/', 'a/')
    .replaceAll('b/product/package/', 'b/')
  if (process.argv.includes('--check')) {
    if (readFileSync(patch, 'utf8').replaceAll('\r\n', '\n') !== output)
      throw new Error('Product bridge patch is not reproducible')
  } else writeFileSync(patch, output)
  console.log('Pinned product bridge patch verified')
} finally {
  const inside = relative(resolve(tmpdir()), resolve(temporary))
  if (!inside.startsWith('..') && inside.startsWith('superdsh-bridge-patch-'))
    rmSync(temporary, { recursive: true, force: true })
}
