import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { ESLint } from 'eslint'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const eslint = new ESLint({ cwd: root })
const filename = resolve(root, 'apps/admin/src/features/boundary-fixture.ts')

test('admin UI rejects backend imports, re-exports and runtime dependencies', async () => {
  const snippets = [
    "import { createApplication } from '../../server/application.ts'",
    "export { createApplication } from '../../server/application.ts'",
    "export * from '../../server/application.ts'",
    "void import('../../server/application.ts')",
    'void import(`../../server/application.ts`)',
    "const backend = require('../../server/application.ts')",
    "type Backend = import('../../server/application.ts').Application",
    "import type { Account } from '@/../server/http/api-router.ts'",
    "import fs from 'node:fs'",
    "import fs from 'fs/promises'",
    "import pg from 'pg'",
    "import redis from 'redis'",
    "import ws from 'ws'",
    "import { S3Client } from '@aws-sdk/client-s3'",
  ]
  for (const text of snippets) {
    const results = await eslint.lintText(text, { filePath: filename })
    assert.ok(
      results[0].messages.some(
        (message) => message.ruleId === 'superdsh-admin/browser-boundary',
      ),
      text,
    )
  }
})

test('frontend API adapters remain allowed while backend may import Node', async () => {
  for (const [filePath, text] of [
    [
      filename,
      "import { serverAgentApi } from '@/features/dashboard/server-agent'",
    ],
    [filename, "import type { ApiResponse } from '@/features/dashboard/types'"],
    [filename, "import { useState } from 'react'"],
    [
      resolve(root, 'apps/admin/server/boundary-fixture.ts'),
      "import pg from 'pg'; import fs from 'node:fs'",
    ],
  ]) {
    const results = await eslint.lintText(text, { filePath })
    assert.equal(
      results[0].messages.some(
        (message) => message.ruleId === 'superdsh-admin/browser-boundary',
      ),
      false,
      text,
    )
  }
})

test('UI compilation roots exclude backend which retains its own full typecheck', () => {
  const directory = resolve(root, 'apps/admin')
  const browser = JSON.parse(readFileSync(resolve(directory, 'tsconfig.json')))
  const server = JSON.parse(
    readFileSync(resolve(directory, 'server/tsconfig.json')),
  )
  const parsed = ts.parseJsonConfigFileContent(browser, ts.sys, directory)
  assert.ok(
    parsed.fileNames.some((file) => file.endsWith('/src/app/layout.tsx')),
  )
  assert.equal(
    parsed.fileNames.some((file) => file.includes('/apps/admin/server/')),
    false,
  )
  const backend = ts.parseJsonConfigFileContent(
    server,
    ts.sys,
    resolve(directory, 'server'),
  )
  assert.ok(
    backend.fileNames.some((file) => file.endsWith('/server/application.ts')),
  )
})
