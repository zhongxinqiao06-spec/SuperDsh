import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
import { prepareOfficeRuntimeEmbedding } from './support/office-runtime-embedding.mjs'
import { presentationSkillIds } from '../agents/presentation-skills.ts'
import {
  decodeOfficeToolResult,
  officeFixtureCompanyTemplate,
  officeFixturePlan,
  officeReviewAction,
} from './support/office-runtime-model.mjs'

async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(150)
  }
}

test(
  'real Host invokes configured office tools; uploaded data produces downloadable Excel/PPT and survives session reload',
  { timeout: 480000 },
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
    const selectedInputs = new Map()
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
      const lastUser =
        body.messages?.findLastIndex((message) => message.role === 'user') ?? -1
      const userText = JSON.stringify(body.messages?.[lastUser]?.content)
      const preferred = userText.includes('JSON配图')
        ? 'illustration_render'
        : userText.includes('配图写入Word')
          ? 'document_report'
          : userText.includes('配图写入PPT')
            ? 'presentation_report'
            : null
      const tool = body.tools?.find((item) =>
        preferred
          ? item.function?.name === preferred
          : [
              'spreadsheet_report',
              'presentation_report',
              'knowledge_search',
            ].includes(item.function?.name) ||
            item.function?.name.startsWith('tool_'),
      )?.function.name
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
        const callTool = (args) => {
          calls.push({ tool, action: args.action ?? 'search' })
          write({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${randomUUID().replaceAll('-', '')}`,
                type: 'function',
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          })
          write({}, 'tool_calls')
        }
        const inputs = wantsChatAttachment
          ? [{ attachmentName: '聊天销售.csv', role: 'input' }]
          : selectedInputs.get(tool)
        let result
        if (oldResult) {
          try {
            result = decodeOfficeToolResult(oldResult.content)
          } catch {
            toolErrors.push(JSON.stringify(oldResult.content))
          }
        }
        if (result?.inspection) {
          try {
            callTool({
              action: 'plan',
              inputsJson: JSON.stringify(inputs),
              planJson: JSON.stringify(officeFixturePlan(tool, result)),
            })
          } catch (error) {
            toolErrors.push(error.message)
            write({
              role: 'assistant',
              content: '测试方案无效，停止本次任务。',
            })
            write({}, 'stop')
          }
        } else if (oldResult) {
          if (tool === 'knowledge_search') knowledgeResults.push(result)
          if (!result?.artifact && !result?.sources && !result?.toolResult)
            toolErrors.push(JSON.stringify(result ?? oldResult.content))
          write({
            role: 'assistant',
            content:
              tool === 'knowledge_search'
                ? '资料回答已引用公司文件。'
                : '业务成果已生成，请在本会话生成成果区域下载。',
          })
          write({}, 'stop')
        } else {
          callTool(
            tool.startsWith('tool_')
              ? {
                  argumentsJson: JSON.stringify({
                    topic: '跨端同步的扩展成果',
                  }),
                }
              : tool === 'knowledge_search'
                ? { query: '经营原则' }
                : { action: 'inspect', inputsJson: JSON.stringify(inputs) },
          )
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
    await prepareOfficeRuntimeEmbedding(configuration.dataDirectory)
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
    const confirmedPlans = new Map()
    const confirmPendingPlan = async (
      sessionId,
      existingArtifacts,
      expectedSources = existingArtifacts ? 1 : 2,
    ) => {
      const { notices } = await api(`/sessions/${sessionId}/runtime/notices`)
      for (const notice of notices ?? []) {
        if (confirmedPlans.has(notice.noticeId)) continue
        const review = officeReviewAction(notice)
        if (!review) continue
        const plans = await api(`/sessions/${sessionId}/office-plans`)
        const plan = plans.items.find((item) => item.id === review.planId)
        assert.ok(
          plan,
          'runtime confirmation points at the persisted public plan',
        )
        assert.equal(plan.state, 'prepared')
        assert.equal(plan.sources.length, expectedSources)
        assert.ok(
          plan.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256)),
        )
        assert.equal(
          plan.confirmation,
          undefined,
          'public plan must not disclose Host approval credentials',
        )
        assert.equal(plan.token, undefined)
        assert.equal(
          (await api(`/sessions/${sessionId}/agent-artifacts`)).items.length,
          existingArtifacts,
        )
        await delay(200)
        assert.equal(
          (await api(`/sessions/${sessionId}/agent-artifacts`)).items.length,
          existingArtifacts,
          'waiting for user confirmation must not create a file',
        )
        const decision = await api(
          `/sessions/${sessionId}/runtime/notices/${notice.noticeId}/respond`,
          review.body,
        )
        assert.equal(decision.ok, true)
        confirmedPlans.set(notice.noticeId, {
          sessionId,
          planId: plan.id,
          sha256: plan.sha256,
          body: review.body,
        })
      }
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
    assert.equal(seed.agents.length, 4)
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
    const templateFile = await officeFixtureCompanyTemplate()
    const companyTemplate = await api('/admin/agents/assets', {
      name: templateFile.filename,
      kind: 'presentation-template',
      contentBase64: templateFile.content.toString('base64'),
    })
    const definitions = []
    for (const original of seed.agents.slice(0, 2)) {
      const tool = original.toolIds.find((id) => id !== 'knowledge_search')
      const templateId =
        tool === 'presentation_report'
          ? companyTemplate.asset.id
          : seed.assets.find((asset) => asset.kind === 'spreadsheet-template')
              .id
      selectedInputs.set(tool, [
        { assetId: sales.asset.id, role: 'input' },
        { assetId: templateId, role: 'template' },
      ])
      const library = await api('/admin/knowledge-bases', {
        name: `现场知识库 ${tool}`,
        description: '新上传数据与公司模板',
        enabled: true,
        assetIds: [sales.asset.id, templateId],
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
    let presentationPreview
    for (const definition of definitions) {
      const creation = {
        connectorId: runtime.connectorId,
        projectId: runtime.projectId,
        runtime: 'dsh',
        runtimeId: 'dsh',
        content: `请使用已绑定的“现场新销售.csv”和该助手绑定的公司模板，调用工具生成${definition.name}的真实文件，先展示方案等我确认。`,
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
          await confirmPendingPlan(sessionId, 0)
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
        definition.toolIds.includes('presentation_report') ? 170000 : 45000,
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
      const confirmation = [...confirmedPlans.values()].find(
        (item) => item.sessionId === sessionId,
      )
      assert.ok(confirmation)
      assert.equal(artifacts.items[0].revision.planHash, confirmation.sha256)
      assert.equal(artifacts.items[0].revision.planId, confirmation.planId)
      assert.equal(
        (
          await api(
            `/sessions/${sessionId}/office-plans/${confirmation.planId}`,
          )
        ).plan.state,
        'completed',
      )
      const [noticeId] = [...confirmedPlans.entries()].find(
        ([, item]) => item === confirmation,
      )
      assert.equal(
        (
          await api(
            `/sessions/${sessionId}/runtime/notices/${noticeId}/respond`,
            confirmation.body,
          )
        ).ok,
        false,
        'duplicate confirmation must not execute a second generation',
      )
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
    const detail = workbook.getWorksheet('现场销售明细')
    assert.equal(detail.getRow(2).getCell('H').result, 200)
    assert.equal(detail.getRow(3).getCell('H').result, 60)
    assert.match(detail.getRow(2).getCell('H').formula, /E2\*F2/)
    assert.equal(workbook.getWorksheet('现场经营汇总').getCell('A2').value, 260)
    assert.ok(
      (await JSZip.loadAsync(files[0])).file(/^xl\/charts\/chart\d+\.xml$/)
        .length,
    )
    const presentation = await JSZip.loadAsync(files[1])
    const slides = await Promise.all(
      presentation
        .file(/^ppt\/slides\/slide\d+\.xml$/)
        .map((entry) => entry.async('string')),
    )
    assert.ok(slides.length >= 5)
    assert.match(slides.join('\n'), /NEW-1/)
    assert.match(slides.join('\n'), /配置中心默认标题/)
    assert.doesNotMatch(slides.join('\n'), /\{\{revenue\}\}/)
    assert.match(slides.join('\n'), /脱敏企业 · 内部资料/)
    assert.ok(
      presentation.file(/^ppt\/charts\/chart\d+\.xml$/).length,
      'PPT contains an editable native chart',
    )
    assert.match(
      slides.join('\n'),
      /<a:tbl>/,
      'PPT contains an editable native table',
    )
    const presentationArtifact = (
      await api(`/sessions/${sessionIds[1]}/agent-artifacts`)
    ).items[0]
    assert.equal(
      presentationArtifact.preview?.state,
      'ready',
      `PPT is rendered before completion: ${JSON.stringify(presentationArtifact.diagnostics)}`,
    )
    assert.ok(Array.isArray(presentationArtifact.preview.missingFonts))
    const previewPath = `/sessions/${sessionIds[1]}/agent-artifacts/${artifactIds[1]}/preview`
    presentationPreview = await api(previewPath)
    assert.equal(presentationPreview.mediaType, 'application/pdf')
    const previewBytes = Buffer.from(
      presentationPreview.contentBase64,
      'base64',
    )
    assert.match(previewBytes.subarray(0, 8).toString('ascii'), /^%PDF-/)
    assert.equal(
      createHash('sha256').update(previewBytes).digest('hex'),
      presentationArtifact.preview.sha256,
      'preview API reads the persisted render of the editable PPT',
    )
    assert.deepEqual(
      presentationPreview.missingFonts,
      presentationArtifact.preview.missingFonts,
    )
    assert.equal(
      (await api(`/sessions/${sessionIds[1]}/agent-artifacts`)).items[0].preview
        .checkedAt,
      presentationArtifact.preview.checkedAt,
      'reading a valid cached preview does not rerender the artifact',
    )
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
    assert.match(JSON.stringify(knowledgeResults[0]), /星河/)
    assert.match(JSON.stringify(knowledgeResults[0]), /按已确认订单安排备货/)
    assert.match(JSON.stringify(knowledgeResults[0]), /paragraph/)
    assert.match(JSON.stringify(knowledgeResults[0]), /sha256/)
    const evidence = await api(
      `/sessions/${knowledge.session.id}/agent-evidence`,
    )
    assert.ok(
      evidence.items.length > 0,
      'retrieved evidence is available to the real session UI',
    )
    assert.ok(
      evidence.items.every(
        (source) => source.id && source.sha256 && source.content,
      ),
    )
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
    assert.deepEqual(
      await api(previewPath),
      presentationPreview,
      'rendered PDF and font diagnostics survive a real platform restart',
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
    await until(async () => {
      await confirmPendingPlan(sessionIds[0], 1)
      if (toolErrors.length) throw new Error(toolErrors.join('\n'))
      return (
        (await api(`/sessions/${sessionIds[0]}/agent-artifacts`)).items
          .length === 2
      )
    }, 'restarted Host reuses frozen business preset')
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
    assert.equal(confirmedPlans.size, 3)
    await until(
      async () =>
        (await api(`/sessions/${sessionIds[0]}/snapshot`)).state.status ===
        'idle',
      'existing session idle before switching',
    )
    const extension = new JSZip()
    extension.file(
      'superdsh-extension.json',
      JSON.stringify({
        schemaVersion: 1,
        id: 'company.runtime-acceptance',
        name: '运行时验收扩展',
        version: '1.0.0',
        license: 'MIT',
        description: '临时测试，非内置工具',
        runtime: 'node',
        entrypoint: 'index.mjs',
        tools: [
          {
            id: 'custom_document',
            name: '定制资料',
            description: '返回真实文件',
            mode: 'action',
            inputSchema: {
              type: 'object',
              required: ['topic'],
              properties: { topic: { type: 'string' } },
              additionalProperties: false,
            },
            configurationSchema: {
              type: 'object',
              properties: { label: { type: 'string' } },
              additionalProperties: false,
            },
            permissions: ['sessions.run'],
            artifactTypes: ['text/plain'],
            timeoutSeconds: 15,
          },
        ],
      }),
    )
    extension.file(
      'index.mjs',
      `let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>text+=v);process.stdin.on('end',()=>{const input=JSON.parse(text);process.stdout.write(JSON.stringify(input.operation==='health'?{ok:true}:{artifacts:[{name:'extension.txt',mediaType:'text/plain',contentBase64:Buffer.from(input.configuration.label+':'+input.arguments.topic).toString('base64')}]}))})`,
    )
    const installed = await api('/admin/extensions/install', {
      contentBase64: await extension.generateAsync({ type: 'base64' }),
    })
    const configured = await api('/admin/tools', {
      name: '动态安装工具',
      description: '真实扩展链路',
      enabled: true,
      settings: { label: 'CURRENT_EXTENSION' },
      implementation: {
        sourceId: installed.id,
        version: installed.version,
        digest: installed.digest,
        toolId: 'custom_document',
      },
    })
    const customSkill = await api('/admin/skills', {
      name: '动态技能',
      description: '只调用新配置工具',
      enabled: true,
      instructions: `DYNAMIC_SKILL: 调用 ${configured.tool.id} 处理用户输入。`,
      requiredToolIds: [configured.tool.id],
    })
    const customAgent = await api('/admin/agents', {
      name: '公司新助手',
      description: '由配置创建',
      instructions: '只使用已授权工具，生成用户要求的资料。',
      published: true,
      toolIds: [configured.tool.id],
      skillIds: [customSkill.skill.id],
      knowledgeBaseIds: [],
      knowledgeAssetIds: [],
      templateAssetIds: [],
    })
    const beforeBinding = await api(`/sessions/${sessionIds[0]}/agent-binding`)
    const switched = await api(
      `/sessions/${sessionIds[0]}/agent-binding`,
      {
        agentDefinitionId: customAgent.agent.id,
        bindingVersion: beforeBinding.bindingVersion,
      },
      'PUT',
    )
    assert.equal(switched.bindingVersion, beforeBinding.bindingVersion + 1)
    await api(`/sessions/${sessionIds[0]}/runtime/messages`, {
      content: '生成公司新资料',
      clientMessageId: 'dynamic-extension-switch',
    })
    await until(async () => {
      await confirmPendingPlan(sessionIds[0], 2, 0)
      if (toolErrors.length) throw new Error(toolErrors.join('\n'))
      return (
        (await api(`/sessions/${sessionIds[0]}/agent-artifacts`)).items
          .length === 3
      )
    }, 'new package executes on an existing real Host session')
    const generated = (
      await api(`/sessions/${sessionIds[0]}/agent-artifacts`)
    ).items.find((item) => item.tool === configured.tool.id)
    assert.ok(
      generated,
      'dynamic implementation is recorded without a builtin ID branch',
    )
    assert.equal(generated.revision.bindingVersion, switched.bindingVersion)
    const downloaded = await api(
      `/sessions/${sessionIds[0]}/attachments/${generated.fileId}`,
    )
    assert.equal(
      Buffer.from(downloaded.contentBase64, 'base64').toString(),
      'CURRENT_EXTENSION:跨端同步的扩展成果',
    )
    assert.ok(
      observedTools.some(
        (entry) =>
          entry.tools.includes(configured.tool.id) &&
          entry.prompt.some((prompt) => prompt.includes('DYNAMIC_SKILL')),
      ),
    )
    assert.equal(
      (await api(`/sessions/${sessionIds[0]}/attachments/${artifactIds[0]}`))
        .contentBase64,
      files[0].toString('base64'),
      'switching preserves prior artifacts',
    )
    assert.ok(
      observedTools.some((entry) =>
        entry.prompt?.some((prompt) =>
          prompt.includes('CUSTOM_CONFIGURED_SKILL_spreadsheet_report'),
        ),
      ),
      'configured skill instructions reach the real Host prompt',
    )
    // The model emits JSON only. A managed worker renders it, and the same
    // authorized PNG is reused by editable PPT and Word in this conversation.
    await until(
      async () =>
        (await api(`/sessions/${sessionIds[0]}/snapshot`)).state.status ===
        'idle',
      'dynamic tool finishes',
    )
    const graphicsAgent = await api('/admin/agents', {
      name: '资料图文助手',
      description: '结构化配图与文档验收',
      instructions: '按用户要求通过已授权工具输出结构化方案。',
      published: true,
      toolIds: [
        'illustration_render',
        'presentation_report',
        'document_report',
      ],
      skillIds: presentationSkillIds,
      knowledgeBaseIds: [],
      knowledgeAssetIds: [],
      templateAssetIds: [],
    })
    const binding = await api(`/sessions/${sessionIds[0]}/agent-binding`)
    await api(
      `/sessions/${sessionIds[0]}/agent-binding`,
      {
        agentDefinitionId: graphicsAgent.agent.id,
        bindingVersion: binding.bindingVersion,
      },
      'PUT',
    )
    let pngBytes
    for (const [index, [tool, content]] of [
      ['illustration_render', '生成JSON配图'],
      ['presentation_report', '把配图写入PPT'],
      ['document_report', '把配图写入Word'],
    ].entries()) {
      await api(`/sessions/${sessionIds[0]}/runtime/messages`, {
        content,
        clientMessageId: `json-artwork-${index}`,
      })
      await until(
        async () => {
          await confirmPendingPlan(sessionIds[0], 3 + index, index ? 1 : 0)
          if (toolErrors.length) throw new Error(toolErrors.join('\n'))
          return (
            (await api(`/sessions/${sessionIds[0]}/agent-artifacts`)).items
              .length ===
            4 + index
          )
        },
        `${tool} saves a confirmed artifact`,
        90000,
      )
      const files = (await api(`/sessions/${sessionIds[0]}/agent-artifacts`))
        .items
      const artifact = files.find(
        (item) =>
          item.tool === tool &&
          item.revision.bindingVersion === binding.bindingVersion + 1,
      )
      assert.ok(artifact)
      assert.deepEqual(
        artifact.revision.skillVersions.map((skill) => skill.id),
        presentationSkillIds,
        'artifacts record the same frozen skills as the Host binding',
      )
      const file = await api(
        `/sessions/${sessionIds[0]}/attachments/${artifact.fileId}`,
      )
      const bytes = Buffer.from(file.contentBase64, 'base64')
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        artifact.sha256,
      )
      if (!index) {
        pngBytes = bytes
        assert.equal(bytes.readUInt32BE(16), 1600)
        const preview = await api(
          `/sessions/${sessionIds[0]}/agent-artifacts/${artifact.fileId}/preview`,
        )
        assert.equal(preview.mediaType, 'image/png')
        assert.equal(preview.contentBase64, file.contentBase64)
        for (const target of ['presentation_report', 'document_report'])
          selectedInputs.set(target, [
            { artifactId: artifact.fileId, role: 'image' },
          ])
      } else {
        const zip = await JSZip.loadAsync(bytes)
        const media = await Promise.all(
          zip
            .file(/^(ppt|word)\/media\/.*\.png$/)
            .map((item) => item.async('nodebuffer')),
        )
        assert.ok(
          media.some((image) => image.equals(pngBytes)),
          'document must contain the exact confirmed illustration bytes',
        )
        assert.equal(artifact.preview.state, 'ready', artifact.preview.error)
      }
      await until(
        async () =>
          (await api(`/sessions/${sessionIds[0]}/snapshot`)).state.status ===
          'idle',
        `${tool} finishes`,
      )
    }
    assert.deepEqual(toolErrors, [])
    assert.ok(
      observedTools.some((entry) =>
        entry.prompt?.some((prompt) =>
          presentationSkillIds.every((id) => prompt.includes(`${id}，版本 1`)),
        ),
      ),
      'the real Host receives all three ordered, versioned PPT skills',
    )
    assert.ok(
      calls.some(
        (call) =>
          call.tool === 'spreadsheet_report' && call.action === 'inspect',
      ) &&
        calls.some(
          (call) =>
            call.tool === 'spreadsheet_report' && call.action === 'plan',
        ) &&
        calls.some(
          (call) =>
            call.tool === 'presentation_report' && call.action === 'inspect',
        ) &&
        calls.some(
          (call) =>
            call.tool === 'presentation_report' && call.action === 'plan',
        ) &&
        calls.some((call) => call.tool === 'knowledge_search'),
    )
  },
)
