// Explicit, expensive smoke test: node apps/admin/test/agent-preview-browser.mjs
// Converts synthetic Office documents and runs the real viewer in a disposable Next app.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { OfficeAssetPreviewRenderer } from '../server/agents/office/preview.ts'
import { createSalesPresentationTemplate } from '../server/agents/office/presentation.ts'
import { createPreviewDocx } from '../server/test/support/office-preview-fixture.mjs'

const admin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(admin, '../..')
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'))
const { chromium } = requireDesktop('playwright')
const dev = process.env.OFFICE_PREVIEW_DEV === '1'
const modes = (
  process.env.OFFICE_PREVIEW_MODES || 'normal,silent,compatibility'
).split(',')
assert.ok(
  modes.every((mode) => ['normal', 'silent', 'compatibility'].includes(mode)),
)
const screenshotDirectory = process.env.OFFICE_PREVIEW_SCREENSHOT_DIR
  ? resolve(process.env.OFFICE_PREVIEW_SCREENSHOT_DIR)
  : undefined
const fixturePrefix = `.next-office-preview-fixture-${process.pid}-`
const fixture = await mkdtemp(join(admin, fixturePrefix))
const next = join(admin, 'node_modules/next/dist/bin/next')
let server, browser
let serverOutput = ''
const results = []

async function freePort() {
  const listener = createServer()
  await new Promise((done) => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port
  await new Promise((done) => listener.close(done))
  return port
}

function startNext(args) {
  const child = spawn(process.execPath, [next, ...args], {
    cwd: fixture,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: args[0] === 'dev' ? 'development' : 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const record = (data) => {
    serverOutput = (serverOutput + data.toString()).slice(-40_000)
    process.stdout.write(data)
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  return child
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  // Terminate only the process tree created by this fixture.
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      {
        windowsHide: true,
        stdio: 'ignore',
      },
    )
    await once(killer, 'exit')
  } else child.kill('SIGTERM')
  await Promise.race([exited, delay(5000)])
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Next exited: ${serverOutput}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {
      /* Next is still starting or compiling the fixture. */
    }
    await delay(500)
  }
  throw new Error(`Next did not start: ${serverOutput}`)
}

async function assertPage(page, number, total) {
  await page
    .getByText(`${number} / ${total}`, { exact: true })
    .waitFor({ timeout: 25_000 })
  const canvas = page.locator('canvas')
  await canvas.waitFor({ state: 'visible', timeout: 25_000 })
  await page.waitForFunction((expected) => {
    const element = document.querySelector('canvas')
    return (
      element &&
      !element.hidden &&
      element.getAttribute('aria-label')?.endsWith(`page ${expected}`)
    )
  }, number)
  const pixels = await canvas.evaluate((element) => {
    const { data } = element
      .getContext('2d')
      .getImageData(0, 0, element.width, element.height)
    let marked = 0
    for (let index = 0; index < data.length; index += 4)
      if (
        data[index + 3] > 0 &&
        Math.min(data[index], data[index + 1], data[index + 2]) < 235
      )
        marked++
    return { width: element.width, height: element.height, marked }
  })
  assert.ok(
    pixels.width > 100 && pixels.height > 100 && pixels.marked > 20,
    JSON.stringify(pixels),
  )
  return pixels
}

async function runCase(base, mode, kind, total) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  })
  if (mode === 'silent')
    await context.addInitScript(() => {
      const OriginalWorker = window.Worker
      window.Worker = class extends OriginalWorker {
        constructor(url, options) {
          // Only replace the viewer's named worker. Other application workers run normally.
          if (options?.name === 'agent-document-preview') {
            const silent = URL.createObjectURL(
              new Blob(['self.onmessage = () => {}'], {
                type: 'text/javascript',
              }),
            )
            super(silent, options)
            URL.revokeObjectURL(silent)
          } else super(url, options)
        }
      }
    })
  if (mode === 'compatibility')
    await context.addInitScript(() => {
      // These newer APIs are absent in browsers still supported by Next 16.
      delete Promise.try
      delete Uint8Array.fromBase64
      delete Uint8Array.prototype.toBase64
      delete Uint8Array.prototype.setFromBase64
    })
  const page = await context.newPage()
  const diagnostic = {
    mode,
    kind,
    environment: dev ? 'development' : 'production',
    console: [],
    errors: [],
    requests: [],
    workers: [],
  }
  page.on('console', (message) =>
    diagnostic.console.push({
      type: message.type(),
      text: message.text().slice(0, 2000),
    }),
  )
  page.on('pageerror', (error) => diagnostic.errors.push(error.message))
  page.on('requestfailed', (request) =>
    diagnostic.requests.push({
      url: request.url(),
      error: request.failure()?.errorText,
    }),
  )
  page.on('response', (response) => {
    if (response.status() >= 400)
      diagnostic.requests.push({
        url: response.url(),
        status: response.status(),
      })
  })
  page.on('worker', (worker) => diagnostic.workers.push(worker.url()))
  const started = Date.now()
  try {
    await page.goto(`${base}/?document=${kind}`, {
      waitUntil: 'domcontentloaded',
    })
    diagnostic.firstPage = await assertPage(page, 1, total)
    diagnostic.firstPageMs = Date.now() - started
    diagnostic.viewportOverflow = await page
      .locator('[aria-label="Document pages"]')
      .evaluate((element) => getComputedStyle(element).overflowY)
    assert.equal(
      diagnostic.viewportOverflow,
      'auto',
      'Fixture must load the actual viewer styles',
    )
    if (screenshotDirectory) {
      await page.screenshot({
        path: join(screenshotDirectory, `${mode}-${kind}-page-1.png`),
        animations: 'disabled',
      })
      await page.locator('canvas').screenshot({
        path: join(screenshotDirectory, `${mode}-${kind}-canvas.png`),
      })
    }
    await page.getByRole('button', { name: 'Next page', exact: true }).click()
    diagnostic.secondPage = await assertPage(page, 2, total)
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await page.getByText('125%', { exact: true }).waitFor()
    await assertPage(page, 2, total)
    diagnostic.ok = true
  } catch (error) {
    diagnostic.ok = false
    diagnostic.failure = error.message
    diagnostic.visibleText = await page
      .locator('body')
      .innerText()
      .catch(() => '')
    if (screenshotDirectory)
      await page
        .screenshot({
          path: join(screenshotDirectory, `${mode}-${kind}-failure.png`),
        })
        .catch(() => {})
  } finally {
    diagnostic.durationMs = Date.now() - started
    results.push(diagnostic)
    if (screenshotDirectory)
      await writeFile(
        join(screenshotDirectory, `${mode}-${kind}.json`),
        JSON.stringify(diagnostic, null, 2),
      )
    console.log(JSON.stringify(diagnostic))
    await context.close()
  }
}

try {
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true })
  const renderer = new OfficeAssetPreviewRenderer()
  const sources = {
    pptx: await createSalesPresentationTemplate(),
    docx: {
      filename: 'browser-preview-guide.docx',
      content: await createPreviewDocx(),
    },
  }
  const documents = {}
  for (const [kind, source] of Object.entries(sources)) {
    const started = Date.now()
    documents[kind] = await renderer.render(source)
    console.log(
      JSON.stringify({
        stage: 'converted',
        kind,
        durationMs: Date.now() - started,
      }),
    )
    if (screenshotDirectory)
      await writeFile(
        join(screenshotDirectory, `${kind}-source-preview.pdf`),
        Buffer.from(documents[kind].contentBase64, 'base64'),
      )
  }
  await mkdir(join(fixture, 'app'), { recursive: true })
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'office-preview-browser-fixture',
      private: true,
      type: 'module',
    }),
  )
  await writeFile(join(fixture, 'documents.json'), JSON.stringify(documents))
  await writeFile(
    join(fixture, 'next.config.mjs'),
    `export default ${JSON.stringify({ devIndicators: false, turbopack: { root }, experimental: { cpus: 1 } })}\n`,
  )
  const tsconfig = JSON.parse(
    await readFile(join(admin, 'tsconfig.json'), 'utf8'),
  )
  // Turbopack treats Windows drive-letter paths as relative inside tsconfig.
  // This fixture is a direct admin child, so ../src resolves the actual owned UI.
  tsconfig.compilerOptions.baseUrl = '.'
  tsconfig.compilerOptions.paths = { '@/*': ['../src/*'] }
  tsconfig.include = [
    'next-env.d.ts',
    'app/**/*.tsx',
    '../src/**/*.d.ts',
    '.next/types/**/*.ts',
    '.next/dev/types/**/*.ts',
  ]
  await writeFile(
    join(fixture, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2),
  )
  await writeFile(
    join(fixture, 'postcss.config.mjs'),
    await readFile(join(admin, 'postcss.config.mjs')),
  )
  await writeFile(
    join(fixture, 'app/fixture.css'),
    `${await readFile(join(admin, 'src/app/globals.css'), 'utf8')}\n@source "../../src";\n`,
  )
  await writeFile(
    join(fixture, 'app/layout.tsx'),
    `import './fixture.css'\nexport default function Layout({children}: {children: React.ReactNode}) { return <html lang="en"><body>{children}</body></html> }\n`,
  )
  await writeFile(
    join(fixture, 'app/page.tsx'),
    `'use client'\nimport * as React from 'react'\nimport {NextIntlClientProvider} from 'next-intl'\nimport {AgentPdfPreview} from '@/components/management/agent-pdf-preview'\nimport documents from '../documents.json'\nexport default function Page() { const [kind,setKind]=React.useState<'pptx'|'docx'>('pptx'); React.useEffect(()=>{setKind(new URLSearchParams(location.search).get('document') === 'docx' ? 'docx' : 'pptx')},[]); const file=documents[kind]; return <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC"><main style={{maxWidth:1000,margin:'24px auto',padding:24}}><h1>Office preview browser fixture: {kind}</h1><AgentPdfPreview contentBase64={file.contentBase64} name={file.name}/></main></NextIntlClientProvider> }\n`,
  )
  if (!dev) {
    const build = startNext(['build'])
    const timer = setTimeout(() => void stopProcess(build), 180_000)
    const [code] = await once(build, 'exit')
    clearTimeout(timer)
    assert.equal(code, 0, 'Fixture production build failed')
  }
  const port = await freePort()
  server = startNext([
    dev ? 'dev' : 'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ])
  const base = `http://127.0.0.1:${port}`
  await waitForServer(base)
  browser = await chromium.launch({ headless: true })
  for (const mode of modes)
    for (const [kind, total] of [
      ['pptx', 5],
      ['docx', 2],
    ])
      await runCase(base, mode, kind, total)
  assert.ok(
    results.every((result) => result.ok),
    'One or more real browser previews failed; inspect the diagnostics above',
  )
} finally {
  await browser?.close()
  await stopProcess(server)
  if (screenshotDirectory)
    await writeFile(
      join(screenshotDirectory, `fixture-${dev ? 'dev' : 'production'}.log`),
      serverOutput,
    )
  const target = resolve(fixture)
  assert.equal(dirname(target), admin)
  assert.ok(basename(target).startsWith(fixturePrefix))
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  })
}
