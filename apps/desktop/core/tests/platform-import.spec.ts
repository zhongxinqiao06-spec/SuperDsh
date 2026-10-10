import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  importLocalSpace,
  publicModelConfig,
} from '../src/main/platform-space-import.ts'
import { DEFAULT_PROFILE } from '../src/contracts/desktop-contract.ts'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
it('backs up and copies history without credentials, AA state or model secrets; refuses nonempty target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superdsh-platform-import-'))
  roots.push(root)
  const source = join(root, 'local'),
    target = join(root, 'account')
  for (const home of [source, target])
    await mkdir(join(home, 'profiles', DEFAULT_PROFILE), { recursive: true })
  await mkdir(join(source, 'sessions'))
  await writeFile(join(source, 'sessions', 'one.jsonl'), '{"text":"history"}\n')
  await writeFile(join(source, '.credentials.yaml'), 'secret-token')
  await mkdir(join(source, 'agents-anywhere'))
  await writeFile(join(source, 'agents-anywhere', 'account.json'), 'secret')
  await writeFile(
    join(source, 'profiles', DEFAULT_PROFILE, 'cordis.patch.yml'),
    '- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        apiKeyEnv: MY_KEY\n        headers: {Authorization: secret}\n        baseURL: https://model.example/v1\n',
  )
  await importLocalSpace(source, target, {
    listProcesses: async () => [],
    isProcessAlive: () => false,
  })
  expect(await readFile(join(source, '.credentials.yaml'), 'utf8')).toBe(
    'secret-token',
  )
  expect(
    await readFile(join(target, 'sessions', 'one.jsonl'), 'utf8'),
  ).toContain('history')
  expect(existsSync(join(target, '.credentials.yaml'))).toBe(false)
  expect(existsSync(join(target, 'agents-anywhere'))).toBe(false)
  const patch = await readFile(
    join(target, 'profiles', DEFAULT_PROFILE, 'cordis.patch.yml'),
    'utf8',
  )
  expect(patch).toContain('https://model.example/v1')
  expect(patch).not.toContain('secret')
  expect(patch).not.toContain('apiKeyEnv')
  const receipt = JSON.parse(
    await readFile(join(target, 'platform-import.json'), 'utf8'),
  ) as { backup: string }
  expect(
    await readFile(join(receipt.backup, 'sessions', 'one.jsonl'), 'utf8'),
  ).toContain('history')
  await expect(
    importLocalSpace(source, target, { listProcesses: async () => [] }),
  ).rejects.toThrow('目标已有历史')
})
it('rejects embedded model URL secrets instead of copying them', () => {
  expect(() =>
    publicModelConfig({ baseURL: 'https://model.example?key=secret' }),
  ).toThrow()
})
