/** Browser capability fixture: real product/Host UI, synthetic remote device data. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export async function installPlatformMainFixture(page) {
  await page.addInitScript(() => {
    const identity = { key: 'a'.repeat(64), generation: 1 }
    const user = {
      userId: 'alice',
      username: 'alice',
      email: null,
      displayName: 'Alice',
      roles: ['member'],
      permissions: [],
      authzVersion: 1,
      resetRequired: false,
    }
    const signedOut = {
      space: 'local',
      origin: null,
      user: null,
      status: 'signed-out',
      identityKey: null,
      identityGeneration: 0,
      connectorId: null,
      connectorRunning: false,
      connectorOnline: false,
      connectorPhase: 'stopped',
      error: null,
      localImportAvailable: false,
    }
    let state = { ...signedOut }
    window.__setPlatformFixtureState = (patch) => {
      state = { ...state, ...patch }
    }
    let timeline = [
      {
        id: 'user-one',
        orderSeq: 1,
        role: 'user',
        status: 'completed',
        content: { text: 'Remote history question' },
      },
      {
        id: 'assistant-one',
        orderSeq: 2,
        role: 'assistant',
        status: 'completed',
        content: { text: 'Remote history answer' },
      },
    ]
    let notices = [
      {
        noticeId: 'notice',
        title: 'Remote approval',
        responseRequired: true,
        status: 'open',
        actions: [{ actionId: 'approve', label: '同意', input: {} }],
      },
    ]
    let remoteFile = 'remote file contents'
    const calls = []
    const listeners = new Set()
    window.__platformFixtureCalls = calls
    const changed = () => {
      for (const listener of listeners)
        listener({
          sessionId: 'remote-session',
          identity,
          event: { type: 'timeline.item.updated' },
        })
    }
    window.superdshPlatform = {
      state: async () => structuredClone(state),
      async loginWithPassword(input) {
        if (
          input.identifier !== 'alice' ||
          input.password !== 'fixture-password'
        )
          throw new Error('Invalid fixture login')
        calls.push({
          operation: 'login',
          origin: input.origin,
          identifier: input.identifier,
        })
        state = {
          ...signedOut,
          origin: input.origin,
          user,
          status: 'ready',
          identityKey: identity.key,
          identityGeneration: identity.generation,
          connectorId: 'native-device',
          connectorRunning: true,
          connectorOnline: true,
          connectorPhase: 'ready',
        }
      },
      async request(request) {
        if (
          request.identity?.key !== identity.key ||
          request.identity?.generation !== identity.generation ||
          !state.user
        )
          throw new Error('Stale fixture identity')
        calls.push(structuredClone(request))
        switch (request.operation) {
          case 'devices':
            return {
              connectors: [
                {
                  id: 'native-device',
                  name: 'Own native device',
                  userId: 'alice',
                  status: state.connectorOnline ? 'online' : 'offline',
                },
                {
                  id: 'remote-device',
                  name: 'Other computer',
                  userId: 'alice',
                  status: 'online',
                },
                {
                  id: 'remote-device',
                  name: 'Other computer',
                  userId: 'alice',
                  status: 'online',
                },
                {
                  id: 'old-device-111',
                  name: 'qzx',
                  userId: 'alice',
                  status: 'offline',
                  deviceOs: 'windows',
                  lastSeenAt: '2026-10-01T08:00:00Z',
                },
                {
                  id: 'old-device-222',
                  name: 'qzx',
                  userId: 'alice',
                  status: 'offline',
                  deviceOs: 'windows',
                  lastSeenAt: '2026-10-02T08:00:00Z',
                },
                {
                  id: 'foreign-device',
                  name: 'Bob private device',
                  userId: 'bob',
                  status: 'online',
                },
              ],
            }
          case 'sessions':
            return {
              sessions: [
                {
                  id: 'remote-session',
                  title: 'Remote example',
                  connectorId: 'remote-device',
                  externalSessionId: 'remote-native-id',
                  cwd: 'D:/remote',
                },
              ],
              nextCursor: null,
            }
          case 'snapshot':
            return {
              session: {
                id: 'remote-session',
                title: 'Remote example',
                cwd: 'D:/remote',
              },
              timeline: { items: structuredClone(timeline), hasMore: false },
              notices: structuredClone(notices),
              state: { selections: { model: 'personal-model' } },
              catalogs: {
                model: {
                  models: [{ id: 'personal-model', name: 'Personal model' }],
                },
              },
              effectiveCapabilities: {
                capabilities: [
                  'session.send_message',
                  'session.interrupt',
                  'runtime.attachment',
                ].map((capabilityId) => ({
                  capabilityId,
                  supported: true,
                  available: true,
                  allowed: true,
                })),
              },
            }
          case 'models':
            return {
              catalog: {
                models: [{ id: 'personal-model', name: 'Personal model' }],
              },
            }
          case 'send':
            timeline = [
              ...timeline,
              {
                id: 'user-two',
                orderSeq: 3,
                role: 'user',
                status: 'completed',
                content: { text: request.body.content },
              },
              {
                id: 'assistant-two',
                orderSeq: 4,
                role: 'assistant',
                status: 'completed',
                content: { text: 'Remote reply in main chat' },
              },
            ]
            changed()
            return { ok: true }
          case 'respond':
            notices = []
            changed()
            return { ok: true }
          case 'interrupt':
            return { ok: true }
          case 'files':
            return {
              entries: [
                { name: 'readme.txt', path: 'readme.txt', type: 'file' },
              ],
            }
          case 'read-file':
            return {
              content: remoteFile,
              sha256: 'fixture-version',
              binary: false,
              truncated: false,
            }
          case 'write-file':
            remoteFile = request.body.content
            return { ok: true }
          case 'terminals':
            return { terminals: [] }
          case 'create-terminal':
            return { terminalId: 'remote-terminal' }
          case 'terminal-snapshot':
            return { dataBase64: btoa('remote terminal output') }
          case 'terminal-write':
            return { ok: true }
          case 'runtimes':
            return { runtimes: [] }
          default:
            return { ok: true }
        }
      },
      async watch(sessionId, ownerId, expected) {
        calls.push({
          operation: 'watch',
          sessionId,
          ownerId,
          identity: expected,
        })
      },
      async stopWatch(ownerId) {
        calls.push({ operation: 'stop-watch', ownerId })
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async logout() {
        state = { ...signedOut, identityGeneration: 2 }
      },
      async connectDevice() {},
      async disconnectDevice() {},
      async localSpace() {},
      async importLocal() {},
      async cancelLogin() {},
      async upload(_sessionId, _files, _identity) {
        return { attachments: [] }
      },
      async login() {
        throw new Error('Optional OAuth fixture is not used')
      },
      async changePassword() {
        throw new Error('Password-change fixture is not used')
      },
    }
  })
}

export async function verifyPlatformMainFixture(page, screenshotDirectory) {
  const screenshots =
    screenshotDirectory ??
    fileURLToPath(
      new URL(
        '../../../../.superdsh-work/device-connection-fix/ui/',
        import.meta.url,
      ),
    )
  await mkdir(screenshots, { recursive: true })
  const source = page.getByRole('button', { name: '当前聊天设备' })
  const selector = page.locator('[data-superdsh-source-selector]')
  const selectDevice = async (id) => {
    await source.click()
    await page.locator(`[role="menuitem"][data-menu-item-id="${id}"]`).click()
  }
  if (!(await source.isVisible()))
    await page.getByRole('button', { name: '展开设备和会话' }).click()
  await source.waitFor()
  await page.evaluate(() => {
    window.__originalNativeEditor = document.querySelector(
      '[contenteditable="true"]',
    )
  })
  const pagesBefore = page.context().pages().length
  await page.getByRole('button', { name: '登录平台', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'SuperDsh 平台账号' })
  await dialog.getByLabel('平台地址').fill('https://fixture.example')
  await dialog.getByLabel('用户名或邮箱').fill('alice')
  await dialog.getByLabel('密码', { exact: true }).fill('fixture-password')
  await page.screenshot({ path: screenshots + '/inline-password-login.png' })
  await dialog.getByRole('button', { name: '登录并同步本地会话' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'alice', exact: true }).waitFor()
  assert.equal(
    page.context().pages().length,
    pagesBefore,
    'Password login must not open another product window',
  )
  assert.equal(
    await selector.getAttribute('data-selected-device'),
    '',
    'Password login keeps the native main target',
  )
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('[contenteditable="true"]') ===
        window.__originalNativeEditor,
    ),
    true,
    'Login must retain the native editor instance',
  )
  assert.equal(await page.locator('.platformPanel').count(), 0)
  await source.click()
  const menu = page.getByRole('menu')
  assert.equal(
    await menu.locator('[data-menu-item-id="native-device"]').count(),
    0,
    'The local Connector is not listed as a second copy of native chat',
  )
  assert.equal(
    await menu.locator('[data-menu-item-id="foreign-device"]').count(),
    0,
  )
  assert.equal(
    await menu.locator('[data-menu-item-id="remote-device"]').count(),
    1,
    'Repeated server rows are deduplicated by ID',
  )
  assert.equal(
    await menu.locator('[data-menu-item-id^="old-device-"]').count(),
    0,
    'Old offline bindings are not shown as the active local computer',
  )
  assert.equal(
    await selector.locator('select').count(),
    0,
    'Device controls must use the shared desktop menu, not an OS-styled select',
  )
  const lightMenuColor = await menu.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  )
  await page.screenshot({ path: screenshots + '/device-menu-light.png' })
  await page.evaluate(() =>
    document.body.setAttribute('data-ds-dark-theme', ''),
  )
  assert.notEqual(
    await menu.evaluate((node) => getComputedStyle(node).backgroundColor),
    lightMenuColor,
    'Shared device menus follow the desktop dark theme',
  )
  await page.screenshot({ path: screenshots + '/device-menu-dark.png' })
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await page.keyboard.press('Escape')
  await page
    .getByRole('button', { name: '查看离线设备（2）', exact: true })
    .click()
  await source.click()
  assert.equal(
    await menu.locator('[data-menu-item-id^="old-device-"]').count(),
    2,
  )
  const offlineLabels = await menu
    .locator('[data-menu-item-id^="old-device-"]')
    .allTextContents()
  assert.equal(
    new Set(offlineLabels).size,
    2,
    'Two same-name devices remain distinguishable without deleting their history',
  )
  await page.keyboard.press('Escape')
  const labelBox = await selector.locator('.productDeviceLabel').boundingBox()
  assert.ok(
    labelBox && labelBox.height < 24,
    'The device label fits on one line in the sidebar',
  )
  await selectDevice('remote-device')
  await page
    .getByRole('button', { name: 'Remote example', exact: true })
    .click()
  const main = page.locator('[data-conversation-target="platform"]')
  await main.getByText('Remote history answer', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-chat-flow]').count(), 1)
  assert.equal(
    await page.locator('[contenteditable="true"]').count(),
    0,
    'Only the selected target composer is active',
  )
  await main.getByRole('button', { name: '同意', exact: true }).click()
  await main.getByLabel('聊天消息').fill('Main chat input for remote computer')
  await main.getByRole('button', { name: '发送', exact: true }).click()
  await main.getByText('Remote reply in main chat', { exact: true }).waitFor()
  await page.screenshot({
    path: screenshots + '/remote-main-capability-fixture.png',
  })
  await main.getByRole('button', { name: '停止', exact: true }).click()
  await main.getByRole('button', { name: '文件', exact: true }).click()
  await main.getByLabel('文件路径').fill('readme.txt')
  await main.getByRole('button', { name: '读取', exact: true }).click()
  await main
    .getByLabel('远端文件内容')
    .fill('changed on selected remote computer')
  await main.getByRole('button', { name: '保存到目标设备' }).click()
  await main.getByRole('button', { name: '终端', exact: true }).click()
  await main.getByRole('button', { name: '新建终端', exact: true }).click()
  await main.getByLabel('终端命令').fill('pwd')
  await main.getByRole('button', { name: '执行', exact: true }).click()
  const calls = await page.evaluate(() => window.__platformFixtureCalls)
  for (const operation of [
    'send',
    'respond',
    'interrupt',
    'write-file',
    'terminal-write',
  ]) {
    const call = calls.find((value) => value.operation === operation)
    assert.ok(call, `${operation} should reach the remote adapter`)
    assert.equal(call.identity.key, 'a'.repeat(64))
    if (['write-file', 'terminal-write'].includes(operation))
      assert.equal(call.connectorId, 'remote-device')
    else assert.equal(call.sessionId, 'remote-session')
  }
  await selectDevice('')
  await page.locator('[contenteditable="true"]').first().waitFor()
  await page.evaluate(() =>
    window.__setPlatformFixtureState({
      connectorOnline: false,
      connectorPhase: 'reconnecting',
    }),
  )
  await selector
    .getByText('本机：连接中断，正在重连', { exact: true })
    .waitFor()
  assert.equal(
    await selector
      .getByText('本机：已在线，可远程访问', { exact: true })
      .count(),
    0,
    'A live child process alone must not report that the computer is online',
  )
  await page.evaluate(() =>
    window.__setPlatformFixtureState({
      connectorOnline: true,
      connectorPhase: 'ready',
    }),
  )
  await selector
    .getByText('本机：已在线，可远程访问', { exact: true })
    .waitFor()
  console.log(
    'Platform main UI fixture passed: inline password login, native target retained, one main remote timeline/composer, scoped chat/approval/cancel/file/terminal operations.',
  )
}
