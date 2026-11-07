import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import test from 'node:test'
import { withTestDatabase } from './support/database.mjs'
import { startNodePlatform } from '../main.ts'

test(
  'production browser manages multimodal connections and downloads a verified uploaded file through real API',
  {
    skip:
      !process.env.SUPERDSH_NODE_TEST_DATABASE_URL ||
      !process.env.SUPERDSH_NODE_TEST_REDIS_URL,
    timeout: 120000,
  },
  async (t) => {
    let cleanupDatabase, platform, browser
    const db = await withTestDatabase({
      after: (fn) => {
        cleanupDatabase = fn
      },
    })
    const directory = await mkdtemp(
      join(tmpdir(), 'superdsh-foundation-web-中文-'),
    )
    t.after(async () => {
      await browser?.close()
      await platform?.close()
      await cleanupDatabase()
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
      await rm(directory, { recursive: true, force: true })
    })
    platform = await startNodePlatform(
      {
        databaseUrl: db.testUrl,
        redisUrl: process.env.SUPERDSH_NODE_TEST_REDIS_URL,
        secret: randomBytes(32).toString('hex'),
        encryptionKey: randomBytes(32).toString('base64url'),
        dataDirectory: directory,
        filesDirectory: join(directory, 'files'),
        hostname: '127.0.0.1',
        port: 0,
        apiPort: 0,
        origins: [],
        dev: false,
        setupToken: 'synthetic-web-setup',
      },
      { log: () => {} },
    )
    await platform.app.identity.createUser(
      {
        username: 'webfoundation',
        displayName: 'Browser tester',
        password: 'synthetic-password',
      },
      { role: 'admin' },
    )
    const { chromium } = createRequire(
      new URL('../../../desktop/package.json', import.meta.url),
    )('playwright')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage(),
      base = `http://127.0.0.1:${platform.address.port}`
    await page.goto(base + '/#/login')
    const login = await page.evaluate(async () => {
      const response = await fetch('/api/v2/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SuperDsh-Agent-Preparation': 'deferred',
        },
        body: JSON.stringify({
          identifier: 'webfoundation',
          password: 'synthetic-password',
        }),
      })
      return response.status
    })
    assert.equal(login, 200)
    await page.goto(base + '/#/models/multimodal')
    await page.getByRole('button', { name: '供应商连接', exact: true }).click()
    await page.getByRole('button', { name: '新增连接', exact: true }).click()
    let dialog = page.getByRole('dialog').last()
    await dialog.getByLabel('名称', { exact: true }).fill('浏览器方舟')
    await dialog.locator('input[type=password]').fill('synthetic-browser-key')
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/v2/admin/models/connections') &&
        r.request().method() === 'POST',
    )
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    const connection = await saved
    assert.equal(connection.status(), 200, await connection.text())
    assert.doesNotMatch(await connection.text(), /synthetic-browser-key/)
    await page.goto(base + '/#/account/files')
    await page.getByRole('button', { name: '上传文件', exact: true }).click()
    dialog = page.getByRole('dialog').last()
    const bytes = Buffer.from('浏览器真实上传下载；脱敏资料。')
    await dialog
      .locator('input[type=file]')
      .setInputFiles({
        name: '公司资料.txt',
        mimeType: 'text/plain',
        buffer: bytes,
      })
    const completed = page.waitForResponse((r) =>
      /\/files\/uploads\/[^/]+\/complete$/.test(new URL(r.url()).pathname),
    )
    await dialog.getByRole('button', { name: '开始上传', exact: true }).click()
    const response = await completed
    assert.equal(response.status(), 200, await response.text())
    const file = await response.json()
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
    await page
      .getByRole('cell', { name: '公司资料.txt', exact: true })
      .waitFor()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载', exact: true }).click()
    const download = await downloadPromise,
      chunks = []
    for await (const chunk of await download.createReadStream())
      chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), bytes)
    assert.equal(
      (await db.query('SELECT count(*) AS total FROM server_agents'))[0].total,
      '0',
      'management never prepares a Harness',
    )
  },
)
