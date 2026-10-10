/** Run inside the real worker image with the supervisor's exact security restrictions. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const require = createRequire(
  '/opt/runtime/apps/desktop/plugins/harness/package.json',
)
const load = (name) => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { LocalSandboxProvider } = await load('@deepseek-ai/dsh-sandbox-local')
const ctx = new Context()
const sandbox = new LocalSandboxProvider(ctx, {
  probeTimeoutMs: 2000,
  runnerCommand: [],
  runnerFailureSignatures: [],
})
try {
  const wrapped = await sandbox.confine(
    [
      'bash',
      '-c',
      'printf ok >/workspace/tool-ok; if printf forbidden >/data/forbidden; then exit 19; fi',
    ],
    { mode: 'workspace-write', workspaceRoot: '/workspace' },
  )
  const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: '/workspace',
    timeout: 5000,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stderr.includes('Permission denied'), result.stderr)
  process.stdout.write(
    JSON.stringify({
      uid: process.getuid(),
      runner: wrapped.argv[0],
      enforcement: wrapped.enforcement,
      confinedWorkspaceWrite: true,
      outsideWriteDenied: true,
    }) + '\n',
  )
} finally {
  await ctx.fiber.dispose()
}
