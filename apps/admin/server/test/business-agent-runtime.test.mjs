import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { startNodePlatform } from '../main.ts'
import { withTestDatabase } from './support/database.mjs'

async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(150)
  }
}

test(
  'real Host invokes configured office tools; uploaded data produces downloadable Excel/PPT and survives session reload',
  { timeout: 180000 },
  async (t) => {
    let cleanupDb
    const db = await withTestDatabase({
      after: (fn) => {
        cleanupDb = fn
      },
    })
    const directory = await mkdtemp(join(tmpdir(), 'superdsh-business-中文-'))
    let platform
    const calls = []
    const forbidden = []
    const toolErrors = []
    const observedTools = []
    const knowledgeResults = []
    const upstream = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      observedTools.push({
        tools: body.tools?.map((item) => item.function?.name) || [],
        prompt: body.messages
          ?.filter((item) => item.role === 'system')
          .map((item) => String(item.content)),
      })
      const tool = body.tools?.find((item) =>
        [
          'spreadsheet_report',
          'presentation_report',
          'knowledge_search',
        ].includes(item.function?.name),
      )?.function.name
      const lastUser =
        body.messages?.findLastIndex((message) => message.role === 'user') ?? -1
      const wantsChatAttachment = JSON.stringify(
        body.messages?.[lastUser]?.content,
      ).includes('聊天附件')
      const oldResult = body.messages
        ?.slice(lastUser + 1)
        .findLast((message) => message.role === 'tool')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const write = (delta, finish = null) =>
        response.write(
          `data: ${JSON.stringify({ id: 'business-model-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        )
      if (tool) {
        for (const item of body.tools)
          if (
            ['bash', 'pwsh', 'read', 'write', 'edit'].includes(
              item.function?.name,
            )
          )
            forbidden.push(item.function.name)
        if (oldResult) {
          const result = JSON.stringify(oldResult.content)
          if (tool === 'knowledge_search') knowledgeResults.push(result)
          if (!result.includes('artifact') && !result.includes('sources'))
            toolErrors.push(result)
          write({
            role: 'assistant',
            content:
              tool === 'knowledge_search'
                ? '资料回答已引用公司文件。'
                : '业务成果已生成，请在本会话生成成果区域下载。',
          })
          write({}, 'stop')
        } else {
          calls.push(tool)
          write({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${randomUUID().replaceAll('-', '')}`,
                type: 'function',
                function: {
                  name: tool,
                  arguments: JSON.stringify(
                    tool === 'knowledge_search'
                      ? { query: '经营原则' }
                      : {
                          ...(wantsChatAttachment
                            ? { attachmentName: '聊天销售.csv' }
                            : {}),
                        },
                  ),
                },
              },
            ],
          })
          write({}, 'tool_calls')
        }
      } else {
        write({ role: 'assistant', content: '企业经营分析' })
        write({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    })
    t.after(async () => {
      try {
        await platform?.close()
      } finally {
        upstream.closeAllConnections()
        if (upstream.listening)
          await new Promise((done) => upstream.close(done))
        await cleanupDb()
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
        assert.ok(directory.includes('superdsh-business-中文-'))
        await rm(directory, { recursive: true, force: true })
      }
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const configuration = {
      databaseUrl: db.testUrl,
      redisUrl: process.env.SUPERDSH_NODE_TEST_REDIS_URL,
      qdrantUrl: process.env.SUPERDSH_NODE_TEST_QDRANT_URL,
      secret: randomBytes(32).toString('hex'),
      encryptionKey: randomBytes(32).toString('base64url'),
      dataDirectory: directory,
      filesDirectory: join(directory, 'files'),
      hostname: '127.0.0.1',
      port: 0,
      apiPort: 0,
      origins: [],
      setupToken: 'business-fixture-setup',
      dev: true,
    }
    const start = () =>
      startNodePlatform(configuration, { web: false, log: () => {} })
    platform = await start()
    let origin = `http://127.0.0.1:${platform.address.port}`
    let token
    const api = async (
      path,
      body,
      method = body === undefined ? 'GET' : 'POST',
    ) => {
      const response = await fetch(`${origin}/api/v2${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          'X-SuperDsh-Agent-Preparation': 'deferred',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      })
      const raw = await response.text()
      const data = raw ? JSON.parse(raw) : null
      assert.ok(
        response.ok,
        `${method} ${path}: ${response.status} ${JSON.stringify(data)}`,
      )
      return data
    }
    const user = await api('/auth/register', {
      username: 'businessadmin',
      displayName: '演示管理员',
      password: 'synthetic-business-password',
      setupToken: 'business-fixture-setup',
      clientType: 'native',
    })
    token = user.accessToken
    const seed = await api('/admin/agents/initialize', {})
    assert.equal(seed.agents.length, 3)
    assert.deepEqual(
      (await api('/admin/agents/demo', {})).agents.map((item) => item.id),
      seed.agents.map((item) => item.id),
    )
    const provider = await api('/admin/models/providers', {
      name: 'Local fixture model',
      protocol: 'openai-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      apiKey: 'synthetic-office-key',
      models: [
        {
          modelId: 'office-fixture',
          name: 'Office fixture',
          maxTokens: 2048,
          contextWindow: 32768,
        },
      ],
    })
    await api(
      '/admin/models/default',
      { providerId: provider.providerId, modelId: 'office-fixture' },
      'PUT',
    )
    const sales = await api('/admin/agents/assets', {
      name: '现场新销售.csv',
      kind: 'knowledge',
      contentBase64: Buffer.from(
        'orderId,date,region,product,quantity,unitPrice,unitCost\nNEW-1,2026-10-01,华东,产品甲,2,100,40\nNEW-2,2026-10-02,华南,产品乙,3,20,10',
      ).toString('base64'),
    })
    const definitions = []
    for (const original of seed.agents.slice(0, 2)) {
      const tool = original.toolIds.find((id) => id !== 'knowledge_search')
      const library = await api('/admin/knowledge-bases', {
        name: `现场知识库 ${tool}`,
        description: '新上传数据与公司模板',
        enabled: true,
        assetIds: [
          sales.asset.id,
          seed.assets.find(
            (asset) =>
              asset.kind ===
              (tool === 'spreadsheet_report'
                ? 'spreadsheet-template'
                : 'presentation-template'),
          ).id,
        ],
      })
      const customSkill = await api('/admin/skills', {
        name: `自定义技能 ${tool}`,
        description: '验证编辑指令真实进入Host',
        enabled: true,
        instructions: `CUSTOM_CONFIGURED_SKILL_${tool}: 请调用 ${tool} 处理用户要求。`,
        requiredToolIds: [tool],
      })
      const toolConfig = (await api('/admin/tools')).items.find(
        (item) => item.id === tool,
      )
      await api(
        `/admin/tools/${tool}`,
        {
          ...toolConfig,
          settings: {
            companyName: '配置中心公司名',
            title: '配置中心默认标题',
          },
        },
        'PUT',
      )
      const saved = await api(
        `/admin/agents/${original.id}`,
        {
          ...original,
          toolIds: original.toolIds.filter((id) => id !== 'knowledge_search'),
          skillIds: [customSkill.skill.id],
          knowledgeBaseIds: [library.knowledgeBase.id],
          knowledgeAssetIds: [],
          templateAssetIds: [],
        },
        'PUT',
      )
      definitions.push(saved.agent)
    }
    await api('/server-agent', {})
    let runtime
    await until(
      async () => {
        runtime = (await api('/server-agent')).agent
        if (runtime.status === 'error') throw new Error(runtime.error)
        return runtime.status === 'running'
      },
      'real full Host readiness',
      125000,
    )
    const modelCatalog = await api('/models/catalog')
    const model = `dsh:model:${Buffer.from(JSON.stringify([`superdsh-${modelCatalog.scope}-${provider.providerId}`, 'office-fixture', null])).toString('base64url')}`
    const permissions = await api(
      `/connectors/${runtime.connectorId}/runtimes/dsh/catalogs/permission`,
    )
    const permission = permissions.catalog.permissions.find(
      (item) => item.metadata?.preset === 'workspace-write',
    ).selectionId
    const files = []
    const artifactIds = []
    const sessionIds = []
    for (const definition of definitions) {
      const creation = {
        connectorId: runtime.connectorId,
        projectId: runtime.projectId,
        runtime: 'dsh',
        runtimeId: 'dsh',
        content: `请调用工具生成${definition.name}的真实文件`,
        clientMessageId: `office-${definition.id}`,
        agentDefinitionId: definition.id,
        selections: { model, permission },
      }
      const created = await api('/sessions/create-and-start', creation)
      const sessionId = created.session.id
      sessionIds.push(sessionId)
      assert.equal(created.session.agentDefinition.version, definition.version)
      let artifacts
      await until(
        async () => {
          artifacts = await api(`/sessions/${sessionId}/agent-artifacts`)
          if (toolErrors.length)
            throw new Error(`Tool returned error: ${toolErrors.join('\n')}`)
          const current = await api(`/sessions/${sessionId}/snapshot`)
          if (
            current.state.status === 'idle' &&
            current.timeline.items.some((item) => item.role === 'assistant') &&
            artifacts.items.length === 0
          )
            throw new Error(
              'Assistant finished without generating the requested artifact',
            )
          return artifacts.items.length === 1
        },
        `real ${definition.name} artifact`,
        45000,
      ).catch(async (error) => {
        throw new Error(
          `${error.message}; tools=${JSON.stringify(observedTools)} calls=${JSON.stringify(calls)} snapshot=${JSON.stringify(await api(`/sessions/${sessionId}/snapshot`)).slice(-16000)}`,
        )
      })
      await until(
        async () =>
          (await api(`/sessions/${sessionId}/snapshot`)).state.status ===
          'idle',
        'business task settles',
      )
      const replay = await api('/sessions/create-and-start', creation)
      assert.equal(
        replay.session.id,
        sessionId,
        'repeat creation must not run another task',
      )
      const file = await api(
        `/sessions/${sessionId}/attachments/${artifacts.items[0].fileId}`,
      )
      files.push(Buffer.from(file.contentBase64, 'base64'))
      artifactIds.push(artifacts.items[0].fileId)
      assert.equal(file.size, files.at(-1).length)
      await api(
        `/admin/agents/${definition.id}`,
        { ...definition, name: `${definition.name}新版本` },
        'PUT',
      )
      const reloaded = await api(`/sessions/${sessionId}/snapshot`)
      assert.equal(
        reloaded.session.agentDefinition.name,
        definition.name,
        'existing session retains frozen definition',
      )
      assert.equal(
        (await api(`/sessions/${sessionId}/agent-artifacts`)).items.length,
        1,
      )
    }
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(files[0])
    const allCells = JSON.stringify(
      workbook.worksheets.map((sheet) => sheet.getSheetValues()),
    )
    assert.match(allCells, /NEW-1/)
    assert.match(allCells, /配置中心默认标题/)
    assert.match(
      allCells,
      /260/,
      'revenue computed from uploaded rows, not demo result',
    )
    const presentation = await JSZip.loadAsync(files[1])
    const slides = await Promise.all(
      presentation
        .file(/^ppt\/slides\/slide\d+\.xml$/)
        .map((entry) => entry.async('string')),
    )
    assert.ok(slides.length >= 5)
    assert.match(slides.join('\n'), /260/)
    assert.match(slides.join('\n'), /配置中心默认标题/)
    assert.doesNotMatch(slides.join('\n'), /\{\{revenue\}\}/)
    const knowledge = await api('/sessions/create-and-start', {
      connectorId: runtime.connectorId,
      projectId: runtime.projectId,
      runtime: 'dsh',
      runtimeId: 'dsh',
      content: '查询公司资料中的经营原则，并引用来源',
      clientMessageId: 'knowledge-source-check',
      agentDefinitionId: seed.agents[2].id,
      selections: { model, permission },
    })
    await until(
      async () =>
        knowledgeResults.length === 1 &&
        (await api(`/sessions/${knowledge.session.id}/snapshot`)).state
          .status === 'idle',
      'knowledge citations through real Host',
    )
    assert.match(knowledgeResults[0], /星河/)
    assert.match(knowledgeResults[0], /按已确认订单安排备货/)
    assert.match(knowledgeResults[0], /paragraph/)
    assert.match(knowledgeResults[0], /sha256/)
    // Restart only this disposable platform. The original native session,
    // frozen agent revision and artifact references must remain usable.
    await platform.close()
    platform = await start()
    origin = `http://127.0.0.1:${platform.address.port}`
    await api('/server-agent', {})
    await until(
      async () => (await api('/server-agent')).agent.status === 'running',
      'Host resumes after platform restart',
      125000,
    )
    assert.equal(
      (await api(`/sessions/${sessionIds[0]}/snapshot`)).session.agentDefinition
        .version,
      definitions[0].version,
    )
    await api(`/sessions/${sessionIds[0]}/runtime/messages`, {
      content: '请使用聊天附件“聊天销售.csv”生成经营分析Excel',
      clientMessageId: 'after-platform-restart',
      attachments: [
        {
          fileId: `file_${randomUUID().replaceAll('-', '')}`,
          name: '聊天销售.csv',
          mediaType: 'text/csv',
          contentBase64: Buffer.from(
            'orderId,date,region,product,quantity,unitPrice,unitCost\nCHAT-1,2026-10-14,华南,新上传附件,3,259,110',
          ).toString('base64'),
        },
      ],
    })
    await until(
      async () =>
        (await api(`/sessions/${sessionIds[0]}/agent-artifacts`)).items
          .length === 2,
      'restarted Host reuses frozen business preset',
    )
    const chatArtifact = (
      await api(`/sessions/${sessionIds[0]}/agent-artifacts`)
    ).items.find((item) => item.fileId !== artifactIds[0])
    const chatFile = await api(
      `/sessions/${sessionIds[0]}/attachments/${chatArtifact.fileId}`,
    )
    const chatWorkbook = new ExcelJS.Workbook()
    await chatWorkbook.xlsx.load(Buffer.from(chatFile.contentBase64, 'base64'))
    const chatCells = JSON.stringify(
      chatWorkbook.worksheets.map((sheet) => sheet.getSheetValues()),
    )
    assert.match(chatCells, /CHAT-1/)
    assert.match(chatCells, /777/)
    assert.doesNotMatch(
      chatCells,
      /NEW-1/,
      'explicit chat attachment must not fall back to the configured data',
    )
    assert.deepEqual(
      forbidden,
      [],
      'business preset must not inherit general shell/filesystem tools',
    )
    assert.deepEqual(toolErrors, [])
    assert.ok(
      observedTools.some((entry) =>
        entry.prompt?.some((prompt) =>
          prompt.includes('CUSTOM_CONFIGURED_SKILL_spreadsheet_report'),
        ),
      ),
      'configured skill instructions reach the real Host prompt',
    )
    assert.ok(
      calls.includes('spreadsheet_report') &&
        calls.includes('presentation_report') &&
        calls.includes('knowledge_search'),
    )
  },
)
