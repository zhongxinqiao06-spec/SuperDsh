/** Real Host and unmodified legacy root plugin in headless Chromium, using disposable data. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { DesktopHostProcess } from '@superdsh/core/backend/host-process'
import { NextProfiles } from '@superdsh/core/backend/profiles'
import { cleanupDisposableTree } from '@superdsh/core/backend/disposable-tree'
import {
  installPlatformMainFixture,
  verifyPlatformMainFixture,
} from './fixtures/platform-main-ui.mjs'
import {
  installServerAgentFixture,
  verifyServerAgentFixture,
} from './fixtures/server-agent-ui.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const home = mkdtempSync(join(tmpdir(), 'superdsh-product-shell-'))
const profiles = new NextProfiles(home)
const profile = profiles.ensure('desktop')
profiles.setFeatures('desktop', { market: false, remoteControl: false })
const pluginName = 'superdsh-test-legacy-root'
const plugin = join(profile, 'node_modules', pluginName)
mkdirSync(plugin, { recursive: true })
writeFileSync(
  join(plugin, 'package.json'),
  JSON.stringify({
    name: pluginName,
    version: '1.0.0',
    type: 'module',
    exports: {
      '.': './index.js',
      './client': './client.js',
      './package.json': './package.json',
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: [
          '@deepseek-ai/dsh-client-ui-layout',
          '@deepseek-ai/dsh-client-ui-renderer',
        ],
      },
    },
  }),
)
writeFileSync(
  join(plugin, 'index.js'),
  'export const name = "legacy-root-fixture"; export function apply() {}\n',
)
writeFileSync(
  join(plugin, 'cordis.patch.yml'),
  `- insert:\n    - id: legacy-root-fixture\n      name: ${pluginName}\n`,
)
// This is the original third-party client format, without a SuperDsh-specific API or source rewrite.
writeFileSync(
  join(plugin, 'client.js'),
  `window.__ModuleLoader__.load({id:${JSON.stringify(pluginName)},factory(require){
const React=require('react');
return {inject:['slots'],apply(ctx){
  window.__legacyFixtureExecuted=true;
  const LegacyRoot=()=>React.createElement('main',{'data-legacy-root-fixture':true},'Unmodified legacy root plugin');
  ctx.effect(()=>{try{return ctx.slots.register({name:'root',locale:'common',priority:-1},LegacyRoot)}
    catch(error){window.__legacyFixtureFailure=error.stack;throw error}},'fixture root');
}};
}});\n`,
)
const manifestFile = join(profile, 'package.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
manifest.dependencies = { ...manifest.dependencies, [pluginName]: '1.0.0' }
manifest.dsh.profile.bundles.push(pluginName)
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
let log = ''
const host = new DesktopHostProcess(
  process.execPath,
  root,
  profile,
  undefined,
  {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: home,
    SUPERDSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    SUPERDSH_CLIENT_MANIFEST:
      require.resolve('@superdsh/ui/client-manifest.json'),
    DSH_NEXT_PREFERENCES: JSON.stringify({ browserAccess: true }),
    DSH_NEXT_TRUSTED_HOSTS: '[]',
  },
  undefined,
  undefined,
  undefined,
  require.resolve('@superdsh/core/backend/host'),
  undefined,
  undefined,
  (chunk) => {
    log = (log + chunk).slice(-20_000)
  },
)
let browser
let timer
let compatibilityPage
let productPage
try {
  const ready = await Promise.race([
    host.start(),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Product shell fixture startup timed out')),
        60_000,
      )
    }),
  ]).finally(() => clearTimeout(timer))
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 840 },
    locale: 'zh-CN',
  })
  const product = await context.newPage()
  productPage = product
  await installPlatformMainFixture(product)
  const errors = []
  product.on('pageerror', (error) => errors.push(error.message))
  product.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return
    log += '\nProduct console: ' + message.text()
    for (const argument of message.args())
      void argument
        .evaluate((value) => (value instanceof Error ? value.stack : null))
        .then((value) => {
          if (value) log += '\nProduct error detail: ' + value
        })
        .catch(() => {})
  })
  await product.goto(ready.url)
  await Promise.race([
    product
      .locator('[data-superdsh-shell][data-superdsh-phase="ready"]')
      .waitFor({ timeout: 45_000 }),
    product
      .locator('main.superdshBoot[role="alert"]')
      .waitFor({ timeout: 45_000 })
      .then(async () => {
        throw new Error(await product.locator('body').innerText())
      }),
  ])
  assert.equal(
    await product.evaluate(() => window.__legacyFixtureExecuted),
    undefined,
    'The product must not execute a third-party root plugin',
  )
  assert.equal(await product.locator('[data-legacy-root-fixture]').count(), 0)
  const welcome = product.getByRole('button', { name: /^(继续|Continue)$/ })
  await welcome.waitFor({ timeout: 15_000 })
  await welcome.click()
  await product
    .getByRole('button', {
      name: /^(稍后配置|Configure later|添加 API Key|Add API key)$/,
    })
    .click({ timeout: 2_000 })
    .catch(() => {})
  const skipPlatformChoice = product.getByRole('button', {
    name: '暂时跳过',
    exact: true,
  })
  if (await skipPlatformChoice.isVisible()) await skipPlatformChoice.click()
  await product
    .locator('[contenteditable="true"]')
    .first()
    .waitFor({ timeout: 15_000 })
  await verifyPlatformMainFixture(product, join(home, 'screenshots'))
  await installServerAgentFixture(product)
  await verifyServerAgentFixture(product)

  const compatibility = await context.newPage()
  compatibilityPage = compatibility
  compatibility.on('pageerror', (error) => {
    log += '\nCompatibility page: ' + error.message
  })
  compatibility.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return
    log += '\nCompatibility console: ' + message.text()
    for (const argument of message.args())
      void argument
        .evaluate((value) => (value instanceof Error ? value.stack : null))
        .then((value) => {
          if (value) log += '\nCompatibility error detail: ' + value
        })
        .catch(() => {})
  })
  const sockets = []
  compatibility.on('websocket', (socket) => sockets.push(socket))
  await compatibility.goto(
    new URL('/compatibility.html?surface=standalone', ready.url).href,
  )
  await compatibility
    .locator('[data-legacy-root-fixture]')
    .waitFor({ timeout: 45_000 })
  assert.equal(
    await compatibility.evaluate(() => window.__legacyFixtureExecuted),
    true,
    'The unmodified third-party client must run in its compatibility renderer',
  )
  assert.equal(
    await product.evaluate(() => window.__legacyFixtureExecuted),
    undefined,
  )
  assert.equal(
    await product
      .locator('[data-superdsh-shell][data-superdsh-phase="ready"]')
      .count(),
    1,
  )
  // Exercise the actual pagehide disposer while DevTools is still attached.
  // Chrome may detach network instrumentation before emitting socket-close
  // notifications during document navigation or page.close().
  const closed = sockets
    .filter((socket) => !socket.isClosed())
    .map((socket) => socket.waitForEvent('close', { timeout: 10_000 }))
  await compatibility.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide')),
  )
  await Promise.all(closed)
  await compatibility.close()
  assert.deepEqual(
    errors,
    [],
    'The product must remain healthy while a legacy root replaces its isolated view',
  )
  console.log(
    'Product shell passed: required Host startup, owned chat root, unmodified legacy root plugin isolation and renderer stream cleanup.',
  )
} catch (error) {
  if (productPage && !productPage.isClosed()) {
    log +=
      '\nProduct text: ' +
      (await productPage.locator('body').innerText()).slice(0, 6000)
  }
  if (compatibilityPage && !compatibilityPage.isClosed()) {
    log +=
      '\nCompatibility text: ' +
      (await compatibilityPage.locator('body').innerText()).slice(0, 6000)
    log +=
      '\nFixture error: ' +
      (await compatibilityPage.evaluate(() => window.__legacyFixtureFailure))
  }
  process.stderr.write(log)
  throw error
} finally {
  clearTimeout(timer)
  await browser?.close()
  await host.stop()
  cleanupDisposableTree(home)
}
