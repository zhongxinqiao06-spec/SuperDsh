/** Real owned renderer against synthetic API v2 capabilities; no user profile or remote service. */
import assert from 'node:assert/strict'
const serverWorkspace = String.raw`D:\服务端数据\agents\alice\workspace`
const reportContent = '地区,销售额\n华东,3200\n华南,1800\n合计,5000\n'

export async function installServerAgentFixture(page) {
  await page.evaluate(
    async ({ serverWorkspace, reportContent }) => {
      const bridge = window.superdshPlatform
      const current = await bridge.state()
      window.__setPlatformFixtureState({
        user: {
          ...current.user,
          permissions: ['models.personal.manage', 'models.use'],
        },
      })
      const originalRequest = bridge.request.bind(bridge)
      const originalSubscribe = bridge.subscribe.bind(bridge)
      const originalWatch = bridge.watch.bind(bridge)
      const originalStop = bridge.stopWatch.bind(bridge)
      const calls = []
      const listeners = new Set()
      const watches = new Map()
      const connectorId = 'server-agent-alice'
      const projectId = 'server-workspace-alice'
      const providerId = 'personal-alice-provider'
      const providerRoute = `superdsh-${'a'.repeat(64)}-${providerId}`
      const modelId = 'fixture-model'
      const base64url = (value) =>
        btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
      const wireModel =
        'dsh:model:' + base64url(JSON.stringify([providerRoute, modelId, null]))
      const wirePermission = 'dsh:permission:' + base64url('workspace-write')
      const productAgent = {
        id: 'agent_business_demo',
        name: '经营分析助手',
        description: '使用已发布的企业资料和报告模板',
        instructions: '输出经营分析',
        knowledgeAssetIds: ['knowledge_fixture'],
        templateAssetIds: ['template_fixture'],
        skillIds: ['sales-analysis'],
        toolIds: ['spreadsheet_report'],
        published: true,
        version: 3,
        createdAt: '2026-10-15T10:00:00Z',
        updatedAt: '2026-10-15T10:00:00Z',
      }
      const reportBytes = new TextEncoder().encode(reportContent)
      const report = {
        fileId: 'file_business_report',
        name: '经营分析.csv',
        mediaType: 'text/csv',
        size: reportBytes.length,
        createdAt: '2026-10-15T10:00:00Z',
      }
      const artifacts = new Map()
      let deferArtifacts = false
      let finishArtifacts
      let agent = {
        status: 'stopped',
        connectorId: null,
        runtimeId: null,
        projectId: null,
        error: null,
      }
      let finishPrepare
      let finishVerify
      let failPrepare = true
      let text = 'server workspace file'
      let notices = [
        {
          noticeId: 'server-approval',
          title: 'Server approval',
          responseRequired: true,
          status: 'open',
          actions: [{ actionId: 'approve', label: '同意', input: {} }],
        },
      ]
      const sessions = [
        {
          id: 'mobile-server-session',
          title: 'Mobile server history',
          connectorId,
          executorKind: 'server-agent',
          runtimeId: 'dsh',
          externalSessionId: 'native-server-history',
          cwd: serverWorkspace,
        },
      ]
      const histories = new Map([
        [
          'mobile-server-session',
          [
            {
              id: 'server-history',
              orderSeq: 1,
              role: 'assistant',
              status: 'completed',
              content: {
                text: 'Phone-created server history in the main chat',
              },
            },
          ],
        ],
      ])
      const providers = [
        {
          providerId,
          name: 'Personal fixture',
          protocol: 'openai-completions',
          baseUrl: 'https://fixture.invalid/v1',
          enabled: true,
          apiKeyConfigured: true,
          models: [
            { modelId, name: 'Personal default fixture', inputTypes: ['text'] },
          ],
        },
      ]
      const catalog = {
        models: [
          {
            id: wireModel,
            selectionId: wireModel,
            displayName: 'Personal default fixture',
            default: false,
            reasoningItems: [],
            metadata: {
              enabled: true,
              provider: providerRoute,
              model: modelId,
              reasoningEffort: null,
            },
          },
        ],
      }
      const emit = async (sessionId) => {
        const state = await bridge.state()
        for (const listener of listeners)
          listener({
            sessionId,
            identity: {
              key: state.identityKey,
              generation: state.identityGeneration,
            },
            event: { type: 'timeline.item.updated' },
          })
      }
      window.__serverAgentFixture = {
        calls,
        watches,
        listeners,
        wireModel,
        publishNextAgentVersion() {
          productAgent.version++
        },
        deferArtifacts() {
          deferArtifacts = true
        },
        releaseArtifacts() {
          finishArtifacts?.()
        },
        releasePrepare() {
          agent = {
            status: 'running',
            connectorId,
            runtimeId: 'dsh',
            projectId,
            error: null,
          }
          finishPrepare?.({ agent: structuredClone(agent) })
        },
        releaseVerify() {
          finishVerify?.({ ok: true })
        },
        setAgentReady() {
          agent = {
            status: 'running',
            connectorId,
            runtimeId: 'dsh',
            projectId,
            error: null,
          }
        },
        deferNextPrepare() {
          agent = {
            status: 'stopped',
            connectorId: null,
            runtimeId: null,
            projectId: null,
            error: null,
          }
        },
      }
      bridge.subscribe = (listener) => {
        listeners.add(listener)
        const cleanup = originalSubscribe(listener)
        return () => {
          listeners.delete(listener)
          cleanup()
        }
      }
      bridge.watch = async (sessionId, ownerId, identity) => {
        watches.set(ownerId, sessionId)
        await originalWatch(sessionId, ownerId, identity)
      }
      bridge.stopWatch = async (ownerId) => {
        watches.delete(ownerId)
        await originalStop(ownerId)
      }
      bridge.request = async (request) => {
        const state = await bridge.state()
        if (
          !state.user ||
          request.identity?.key !== state.identityKey ||
          request.identity?.generation !== state.identityGeneration
        )
          throw new Error('Stale fixture identity')
        calls.push(structuredClone(request))
        const alice = state.user.userId === 'alice'
        switch (request.operation) {
          case 'agents':
            return {
              items: alice
                ? [
                    structuredClone(productAgent),
                    { ...productAgent, id: 'draft-agent', published: false },
                  ]
                : [],
              total: alice ? 2 : 0,
            }
          case 'agent-artifacts': {
            const result = {
              items: alice
                ? structuredClone(artifacts.get(request.sessionId) ?? [])
                : [],
              agentDefinition: alice
                ? (sessions.find((session) => session.id === request.sessionId)
                    ?.agentDefinition ?? null)
                : null,
            }
            if (deferArtifacts) {
              deferArtifacts = false
              return new Promise((resolve) => {
                finishArtifacts = () => resolve(result)
              })
            }
            return result
          }
          case 'download-attachment':
            if (
              !alice ||
              request.sessionId !== 'new-server-session' ||
              request.attachmentId !== report.fileId
            )
              throw new Error(
                'Attachment does not belong to this account/session',
              )
            return {
              ...report,
              contentBase64: btoa(String.fromCharCode(...reportBytes)),
            }
          case 'devices':
            return {
              connectors:
                alice && agent.status === 'running'
                  ? [
                      {
                        id: connectorId,
                        userId: 'alice',
                        executorKind: 'server-agent',
                        name: 'Server label',
                        status: 'online',
                      },
                    ]
                  : [],
            }
          case 'server-agent':
            return {
              agent: alice
                ? structuredClone(agent)
                : {
                    status: 'stopped',
                    connectorId: null,
                    runtimeId: null,
                    projectId: null,
                    error: null,
                  },
            }
          case 'prepare-server-agent': {
            if (agent.status === 'running')
              return { agent: structuredClone(agent) }
            if (failPrepare) {
              failPrepare = false
              throw new Error(
                'Fixture worker is unavailable; retry preparation',
              )
            }
            agent = { ...agent, status: 'starting' }
            return new Promise((resolve) => {
              finishPrepare = resolve
            })
          }
          case 'personal-providers':
            return { providers: alice ? structuredClone(providers) : [] }
          case 'personal-default':
            return { selection: alice ? { providerId, modelId } : null }
          case 'verify-personal-provider':
            return new Promise((resolve) => {
              finishVerify = resolve
            })
          case 'update-personal-provider': {
            Object.assign(providers[0], { ...request.body, apiKey: undefined })
            return { provider: structuredClone(providers[0]) }
          }
          case 'set-personal-default':
            return { selection: request.body.selection }
          case 'projects':
            return {
              projects:
                alice && agent.status === 'running'
                  ? [
                      {
                        id: 'different-project',
                        connectorId: 'another-computer',
                        name: 'Unrelated workspace',
                        workspacePath: '/workspace',
                      },
                      {
                        id: projectId,
                        connectorId,
                        name: '服务端工作区',
                        workspacePath: serverWorkspace,
                      },
                    ]
                  : [],
            }
          case 'sessions':
            return {
              sessions: alice ? structuredClone(sessions) : [],
              nextCursor: null,
            }
          case 'runtimes':
            return {
              runtimes: [
                {
                  runtimeId: 'dsh',
                  runtimeType: 'dsh',
                  active: true,
                  status: 'running',
                },
              ],
            }
          case 'model-catalog':
            return {
              scope: 'a'.repeat(64),
              default: { providerId, modelId },
              providers: [],
            }
          case 'runtime-models':
          case 'models':
            return { catalog: structuredClone(catalog) }
          case 'runtime-permissions':
            return {
              catalog: {
                permissions: [
                  {
                    id: wirePermission,
                    selectionId: wirePermission,
                    displayName: '工作区写入',
                    default: true,
                    metadata: { enabled: true, preset: 'workspace-write' },
                  },
                ],
              },
            }
          case 'create-project':
            throw new Error(
              'A server target must use its prepared project, not create an arbitrary workspace',
            )
          case 'create-session': {
            if (
              request.body.projectId !== projectId ||
              request.body.cwd !== serverWorkspace ||
              request.body.selections.model !== wireModel
            )
              throw new Error('Incorrect server workspace/model mapping')
            if (request.body.agentDefinitionId !== productAgent.id)
              throw new Error(
                'The selected product Agent must be sent at the creation boundary',
              )
            const session = {
              id: 'new-server-session',
              title: 'New server session',
              connectorId,
              executorKind: 'server-agent',
              runtimeId: 'dsh',
              externalSessionId: 'new-native-server-session',
              cwd: serverWorkspace,
              agentDefinition: {
                id: productAgent.id,
                name: productAgent.name,
                version: productAgent.version,
              },
            }
            sessions.unshift(session)
            artifacts.set(session.id, [{ ...report }])
            histories.set(session.id, [
              {
                id: 'initial-user',
                orderSeq: 1,
                role: 'user',
                status: 'completed',
                content: { text: request.body.content },
              },
              {
                id: 'initial-assistant',
                orderSeq: 2,
                role: 'assistant',
                status: 'completed',
                content: { text: 'Server reply in the existing main chat' },
              },
            ])
            return { session }
          }
          case 'snapshot':
            return {
              session: sessions.find((value) => value.id === request.sessionId),
              timeline: {
                items: histories.get(request.sessionId) ?? [],
                hasMore: false,
              },
              notices,
              state: { status: 'idle', selections: { model: wireModel } },
              eventCursor: `seq:${histories.get(request.sessionId)?.length ?? 0}`,
              catalogs: { model: structuredClone(catalog) },
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
          case 'send': {
            const items = histories.get(request.sessionId) ?? []
            items.push({
              id: `follow-up-${items.length}`,
              orderSeq: items.length + 1,
              role: 'assistant',
              status: 'completed',
              content: { text: 'Shared server session follow-up' },
            })
            histories.set(request.sessionId, items)
            await emit(request.sessionId)
            return { ok: true }
          }
          case 'respond':
            notices = []
            await emit(request.sessionId)
            return { ok: true }
          case 'interrupt':
            return { ok: true }
          case 'read-file':
            return { content: text, sha256: 'fixture-server-version' }
          case 'write-file':
            text = request.body.content
            return { ok: true }
          case 'terminals':
            return { terminals: [] }
          case 'create-terminal':
            return { terminalId: 'server-terminal' }
          case 'terminal-snapshot':
            return { dataBase64: btoa('server terminal workspace') }
          case 'terminal-write':
            return { ok: true }
          default:
            return originalRequest(request)
        }
      }
    },
    { serverWorkspace, reportContent },
  )
}

export async function verifyServerAgentFixture(page) {
  const selector = page.locator('[data-superdsh-source-selector]')
  const useServer = selector.getByRole('button', {
    name: '使用服务端 Agent',
    exact: true,
  })
  const native = async () => {
    await page.getByRole('button', { name: '当前聊天设备' }).click()
    await page.locator('[role="menuitem"][data-menu-item-id=""]').click()
  }
  await useServer.click()
  await selector
    .getByText('Fixture worker is unavailable; retry preparation', {
      exact: true,
    })
    .waitFor()
  assert.equal(await selector.getAttribute('data-selected-device'), '')
  await page.locator('[contenteditable="true"]').first().waitFor()
  await useServer.click()
  await native()
  await page.evaluate(() => window.__serverAgentFixture.releasePrepare())
  await page.waitForTimeout(3200)
  assert.equal(
    await selector.getAttribute('data-selected-device'),
    '',
    'A later target choice must win over a pending preparation',
  )
  await useServer.click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-superdsh-source-selector]')
        ?.getAttribute('data-selected-device') === 'server-agent-alice',
  )
  const main = page.locator('[data-conversation-device="server-agent-alice"]')
  await main.getByRole('button', { name: '聊天', exact: true }).click()
  await main.getByRole('button', { name: '新会话模型', exact: true }).waitFor()
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="新会话模型"]')
      ?.textContent.includes('Personal default fixture'),
  )
  await page.waitForFunction(
    (workspace) =>
      document.querySelector('.productRemoteWorkspace input')?.value ===
      workspace,
    serverWorkspace,
  )
  assert.equal(
    await main.getByLabel('服务端工作区').inputValue(),
    serverWorkspace,
  )
  assert.equal(await main.getByLabel('服务端工作区').isDisabled(), true)
  await main.getByRole('button', { name: '产品智能体', exact: true }).click()
  await page
    .locator('[role="menuitem"][data-menu-item-id="agent_business_demo"]')
    .click()
  assert.equal(
    await page.locator('[data-menu-item-id="draft-agent"]').count(),
    0,
  )
  await main
    .getByText('使用已发布的企业资料和报告模板 · 会话创建后固定此智能体版本', {
      exact: true,
    })
    .waitFor()
  await main.getByLabel('聊天消息').fill('New service session from desktop')
  await main.getByRole('button', { name: '发送', exact: true }).click()
  await main
    .getByText('Server reply in the existing main chat', { exact: true })
    .waitFor()
  assert.equal(await page.locator('[data-chat-flow]').count(), 1)
  assert.equal(await page.locator('[contenteditable="true"]').count(), 0)
  await main
    .getByText('智能体：经营分析助手 · v3（本会话已固定）', { exact: true })
    .waitFor()
  assert.equal(
    await main.getByRole('button', { name: '产品智能体', exact: true }).count(),
    0,
  )
  const results = main.getByRole('region', { name: '生成成果' })
  const downloading = page.waitForEvent('download')
  await results
    .getByRole('button', { name: '下载 经营分析.csv', exact: true })
    .click()
  const download = await downloading
  try {
    assert.equal(download.suggestedFilename(), '经营分析.csv')
    const stream = await download.createReadStream()
    assert.ok(stream)
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString('utf8'), reportContent)
  } finally {
    await download.delete()
  }
  await page.evaluate(() => {
    window.__serverAgentFixture.publishNextAgentVersion()
    window.__serverAgentFixture.deferArtifacts()
  })
  const artifactRequests = await page.evaluate(
    () =>
      window.__serverAgentFixture.calls.filter(
        (call) => call.operation === 'agent-artifacts',
      ).length,
  )
  await results.getByRole('button', { name: '刷新成果', exact: true }).click()
  await page.waitForFunction(
    (count) =>
      window.__serverAgentFixture.calls.filter(
        (call) => call.operation === 'agent-artifacts',
      ).length > count,
    artifactRequests,
  )
  await page
    .getByRole('button', { name: 'Mobile server history', exact: true })
    .click()
  await main
    .getByText('Phone-created server history in the main chat', { exact: true })
    .waitFor()
  await page.evaluate(() => window.__serverAgentFixture.releaseArtifacts())
  assert.equal(
    await main.getByRole('region', { name: '生成成果' }).count(),
    0,
    'A late artifact list cannot enter another session',
  )
  assert.equal(await main.locator('.productAgentBinding').count(), 0)
  await page
    .getByRole('button', { name: 'New server session', exact: true })
    .click()
  await main
    .getByText('智能体：经营分析助手 · v3（本会话已固定）', { exact: true })
    .waitFor()
  await main
    .getByRole('region', { name: '生成成果' })
    .getByRole('button', { name: '下载 经营分析.csv', exact: true })
    .waitFor()
  assert.equal(
    await page.locator('[data-chat-flow]').count(),
    1,
    'Returning to a bound Agent uses the original main conversation region',
  )
  await page
    .getByRole('button', { name: 'Mobile server history', exact: true })
    .click()
  await main
    .getByText('Phone-created server history in the main chat', { exact: true })
    .waitFor()
  await main.getByRole('button', { name: '同意', exact: true }).click()
  await main.getByLabel('聊天消息').fill('Continue same mobile session')
  await main.getByRole('button', { name: '发送', exact: true }).click()
  await main
    .getByText('Shared server session follow-up', { exact: true })
    .waitFor()
  await main.getByRole('button', { name: '停止', exact: true }).click()
  await main.getByRole('button', { name: '文件', exact: true }).click()
  await main.getByLabel('文件路径').fill('notes.txt')
  await main.getByRole('button', { name: '读取', exact: true }).click()
  await main.getByLabel('远端文件内容').fill('Write only to server workspace')
  await main.getByRole('button', { name: '保存到目标设备' }).click()
  await main.getByRole('button', { name: '终端', exact: true }).click()
  await main.getByRole('button', { name: '新建终端', exact: true }).click()
  await main.getByLabel('终端命令').fill('pwd')
  await main.getByRole('button', { name: '执行', exact: true }).click()
  const calls = await page.evaluate(() => window.__serverAgentFixture.calls)
  const created = calls.find((value) => value.operation === 'create-session')
  assert.ok(created)
  assert.equal(created.body.projectId, 'server-workspace-alice')
  assert.equal(created.body.cwd, serverWorkspace)
  assert.equal(created.body.agentDefinitionId, 'agent_business_demo')
  assert.match(created.body.selections.model, /^dsh:model:/)
  assert.equal(
    calls.some((value) => value.operation === 'create-project'),
    false,
  )
  for (const operation of ['write-file', 'terminal-write']) {
    const call = calls.find((value) => value.operation === operation)
    assert.equal(call?.connectorId, 'server-agent-alice')
  }
  const fileRequest = calls.find((value) => value.operation === 'write-file')
  const terminalRequest = calls.find(
    (value) => value.operation === 'create-terminal',
  )
  assert.equal(fileRequest.query.root, serverWorkspace)
  assert.equal(terminalRequest.query.root, serverWorkspace)
  assert.equal(terminalRequest.body.cwd, serverWorkspace)
  await native()
  await page.waitForFunction(
    () =>
      window.__serverAgentFixture.watches.size === 0 &&
      window.__serverAgentFixture.listeners.size === 0,
  )
  await page.locator('[contenteditable="true"]').first().waitFor()
  assert.equal(
    await page.getByRole('button', { name: '产品智能体', exact: true }).count(),
    0,
  )
  assert.equal(await page.getByRole('region', { name: '生成成果' }).count(), 0)
  await page.getByRole('button', { name: 'alice', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'SuperDsh 平台账号' })
  await dialog
    .locator('summary')
    .filter({ hasText: '个人模型 · 服务端 Agent' })
    .click()
  const personal = dialog.locator('section[aria-label="个人模型"]')
  await personal.getByText('Personal fixture', { exact: true }).waitFor()
  await personal.getByRole('button', { name: '编辑', exact: true }).click()
  assert.equal(
    await personal.getByLabel('API Key（留空保留原值）').inputValue(),
    '',
  )
  await personal.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() =>
    window.__serverAgentFixture.calls.some(
      (call) => call.operation === 'update-personal-provider',
    ),
  )
  const saved = await page.evaluate(() =>
    window.__serverAgentFixture.calls.find(
      (call) => call.operation === 'update-personal-provider',
    ),
  )
  assert.equal(
    'apiKey' in saved.body,
    false,
    'Blank secret keeps the saved key without resubmitting it',
  )
  await personal.getByRole('button', { name: '编辑', exact: true }).click()
  await personal
    .getByLabel('API Key（留空保留原值）')
    .fill('unsaved-synthetic-secret')
  await personal.getByRole('button', { name: '验证连接', exact: true }).click()
  await page.evaluate(() =>
    window.__setPlatformFixtureState({
      user: {
        userId: 'bob',
        username: 'bob',
        displayName: 'Bob',
        resetRequired: false,
        permissions: ['models.personal.manage', 'models.use'],
      },
      identityKey: 'b'.repeat(64),
      identityGeneration: 2,
      connectorId: null,
    }),
  )
  await dialog.getByText('已登录：Bob · bob', { exact: true }).waitFor()
  await page.evaluate(() => window.__serverAgentFixture.releaseVerify())
  assert.equal(
    await dialog.locator('input[type="password"]').count(),
    1,
    'Only the ordinary login password remains after the personal editor is cleared',
  )
  assert.equal(
    await personal.getByText('连接验证成功', { exact: true }).count(),
    0,
    'Late verification cannot affect the next account',
  )
  assert.equal(
    await personal.getByText('Personal fixture', { exact: true }).count(),
    0,
  )
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  console.log(
    'Server Agent renderer fixture passed: zero-computer preparation/retry, product Agent selection/frozen version, real CSV download bytes, artifact target-switch fence, opaque model default, one main history/composer, scoped file/terminal, subscription cleanup and account-scoped key editor.',
  )
}
