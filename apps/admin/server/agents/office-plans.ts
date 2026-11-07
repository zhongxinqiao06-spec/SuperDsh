import { randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiError, text, utcNow, type Account } from '../http/api-router.ts'
import { requirePermission } from '../conversations/store.ts'
import {
  json,
  type Row,
  type SqlConnection,
} from '../infrastructure/database.ts'
import type { BusinessAgentService } from './service.ts'
import type { AgentBinding, AgentToolContext } from './contracts.ts'
import type {
  ArtifactRevision,
  OfficePlan,
  OfficeConfirmation,
} from './office-contracts.ts'
import { AgentResourceService } from './resources.ts'
import {
  officeHash,
  officeJson,
  resolveOfficeSources,
  loadOfficeSources,
} from './office-sources.ts'
import { managedToolWork, resolveManagedTool } from './managed-tool.ts'
import { operationDescription } from './office-plan-language.ts'
import { repairRenderedDocument } from './office/rendered-repair.ts'
import { reviseDocumentStructure } from './office/document-revision.ts'
import {
  renderAndCacheArtifactPreview,
  withArtifactPreview,
} from './artifact-preview-cache.ts'

// Coalesce the same confirmed call only; Harness remains the execution queue.
const executing = new WeakMap<BusinessAgentService, Map<string, Promise<Row>>>()

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export const officePlanHash = (
  value: Pick<OfficePlan, 'document' | 'sources' | 'previousArtifactId'>,
) => officeHash(canonical(value))

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {}
}
function warningsFrom(value: unknown): string[] {
  const object = record(value)
  const list = [
    ...(Array.isArray(object.issues) ? object.issues : []),
    ...(Array.isArray(object.anomalies) ? object.anomalies : []),
    ...(Array.isArray(object.diagnostics) ? object.diagnostics : []),
  ]
  return [
    ...new Set(
      list
        .map((item) =>
          typeof item === 'string' ? item : text(record(item).message),
        )
        .filter(Boolean),
    ),
  ].slice(0, 100)
}

export function officePlanSummary(
  plan: Pick<
    OfficePlan,
    'title' | 'tool' | 'sources' | 'document' | 'warnings'
  >,
) {
  const lines = [
    `## ${plan.title}`,
    '',
    '### 输入资料',
    ...plan.sources.map(
      (source) =>
        `- ${source.name}（${source.role === 'template' ? '模板' : source.role === 'image' ? '图片' : '资料'}；版本 ${source.sha256.slice(0, 8)}）`,
    ),
  ]
  if (!plan.sources.length) lines.push('- 新建文档，不使用演示资料')
  if (Array.isArray(plan.document.sheets)) {
    lines.push('', '### 工作表与计算口径')
    for (const raw of Array.isArray(plan.document.sheets)
      ? plan.document.sheets
      : []) {
      const sheet = record(raw)
      lines.push(
        `- **${text(sheet.name)}**：${typeof sheet.source === 'string' ? `数据表 ${sheet.source}` : '新建数据表'}`,
      )
      if (typeof sheet.source !== 'string') {
        const source = record(sheet.source)
        const rows = Array.isArray(source.rows) ? source.rows : []
        lines.push(
          `  - 字段：${Array.isArray(source.columns) ? source.columns.join('、') : ''}；共 ${rows.length} 行`,
        )
        for (const row of rows.slice(0, 10))
          lines.push(`  - 数据：${JSON.stringify(row)}`)
        if (rows.length > 10)
          lines.push(
            '  - 此处展示前 10 行；请在成果与资料依据中查看完整方案数据。',
          )
      }
      for (const rawOp of Array.isArray(sheet.operations)
        ? sheet.operations
        : []) {
        const op = record(rawOp)
        lines.push(`  - ${operationDescription(op)}`)
      }
      for (const chart of Array.isArray(sheet.charts) ? sheet.charts : [])
        lines.push(`  - 图表：${text(record(chart).title)}`)
    }
    for (const selection of Array.isArray(plan.document.sources)
      ? plan.document.sources
      : []) {
      const source = record(selection)
      lines.push(
        `- 输入 ${Number(source.fileIndex) + 1} / ${text(source.sheet, '自动识别工作表')}，表头第 ${Number(source.headerRow) || '自动识别'} 行；${
          Object.entries(record(source.mapping))
            .map(([a, b]) => `${a} → ${String(b)}`)
            .join('；') || '保留原字段名'
        }`,
      )
    }
    if (plan.document.allowValueExtraction)
      lines.push(
        '',
        '**仅提取表格值：已知不支持的原始视觉对象不会复制到结果。**',
      )
  } else if (Array.isArray(plan.document.nodes)) {
    lines.push(
      '',
      '### 结构化配图方案',
      `用途：${text(plan.document.purpose, '文档配图')}`,
      `布局：${text(plan.document.layout)}；输出 1600 × 900 PNG`,
      '由工具按 JSON 确定性渲染，无外部生图调用。',
    )
    for (const node of plan.document.nodes) {
      const item = record(node)
      lines.push(
        `- **${text(item.title)}**${item.value ? '：' + text(item.value) : ''}${item.parentId ? '；上级 ' + text(item.parentId) : ''}`,
        text(item.detail),
      )
    }
  } else if (Array.isArray(plan.document.sections)) {
    lines.push(
      '',
      '### 文档章节',
      `用途：${text(plan.document.purpose, '按用户要求生成')}`,
      `目录：${plan.document.tableOfContents === false ? '不生成' : '生成可更新目录'}`,
    )
    for (const [index, raw] of plan.document.sections.entries()) {
      const section = record(raw)
      lines.push(
        `${index + 1}. **${text(section.title)}**（${Number(section.level) || 1} 级标题）`,
      )
      for (const rawBlock of Array.isArray(section.blocks)
        ? section.blocks
        : []) {
        const block = record(rawBlock)
        if (block.text) lines.push('   ' + text(block.text).slice(0, 500))
        if (Array.isArray(block.items))
          lines.push('   ' + block.items.join('；').slice(0, 500))
        if (block.columns)
          lines.push(
            '   表格：' +
              JSON.stringify({
                columns: block.columns,
                rows: block.rows,
              }).slice(0, 1500),
          )
        if (block.imageId) lines.push('   图片：' + text(block.imageId))
        if (block.sourceId) lines.push('   引用来源：' + text(block.sourceId))
      }
    }
  } else if (plan.document.prompt) {
    lines.push(
      '',
      '### 配图方案',
      `用途：${text(plan.document.purpose)}`,
      `数量：${Number(plan.document.imageCount) || 1} 张；尺寸：${text(plan.document.size)}`,
      text(plan.document.prompt),
    )
  } else if (plan.document.arguments) {
    lines.push(
      '',
      '### 工具操作参数',
      '以下参数经已授权工具的输入 Schema 检查。',
      '```json',
      JSON.stringify(plan.document.arguments, null, 2),
      '```',
    )
  } else {
    lines.push(
      '',
      `用途：${text(plan.document.purpose, '按用户要求生成')}`,
      `受众：${text(plan.document.audience, '通用企业')}`,
      '',
      '### 幻灯片安排',
    )
    if (plan.document.brand)
      lines.push(
        `品牌风格：${Object.entries(record(plan.document.brand))
          .map(
            ([key, value]) =>
              `${({ company: '公司', fontFace: '字体', accentColor: '强调色', textColor: '文字色', backgroundColor: '背景色' } as Record<string, string>)[key] ?? key} ${String(value)}`,
          )
          .join('；')}`,
      )
    for (const [index, slide] of (Array.isArray(plan.document.slides)
      ? plan.document.slides
      : []
    ).entries()) {
      const item = record(slide)
      lines.push(
        `${index + 1}. **${text(item.title)}**`,
        typeof item.body === 'string'
          ? item.body
          : Array.isArray(item.body)
            ? item.body.join('；')
            : '',
      )
      if (item.template) {
        const template = record(item.template)
        lines.push(
          `   模板第 ${Number(template.slide)} 页，标题区域 ${text(template.titleShape, '自动布局')}，正文区域 ${text(template.bodyShape, '自动布局')}；内容区域 ${JSON.stringify(template.contentRegion ?? '使用默认布局')}`,
        )
      }
      if (item.table) {
        const table = record(item.table)
        lines.push(
          `   表格字段：${Array.isArray(table.columns) ? table.columns.join('、') : ''}；数据：${JSON.stringify(table.rows)}`,
        )
      }
      if (item.chart)
        lines.push(`   图表数据与口径：${JSON.stringify(item.chart)}`)
      if (item.design)
        lines.push('   设计与组件：' + JSON.stringify(item.design))
      if (item.imageId) lines.push(`   图片：${text(item.imageId)}`)
      if (Array.isArray(item.sourceIds) && item.sourceIds.length)
        lines.push(`   资料来源：${item.sourceIds.join('、')}`)
    }
  }
  lines.push(
    '',
    '### 输出',
    plan.document.arguments
      ? '- 保存工具执行结果；有成果文件时显示在当前会话。'
      : `- 文件：${text(plan.document.filename, plan.title + (Array.isArray(plan.document.sheets) ? '.xlsx' : Array.isArray(plan.document.sections) ? '.docx' : plan.document.prompt || plan.document.nodes ? '.png' : '.pptx'))}`,
    '- 结果归属当前会话；修改会生成新版本，保留原成果。',
  )
  if (plan.document.designTheme)
    lines.push('', '### 设计资源', JSON.stringify(plan.document.designTheme))
  if (plan.warnings.length)
    lines.push(
      '',
      '### 检查提示',
      ...plan.warnings.map((warning) => `- ${warning}`),
    )
  return lines.join('\n').slice(0, 24000)
}

export class OfficePlanService {
  readonly service: BusinessAgentService
  constructor(service: BusinessAgentService) {
    this.service = service
  }

  async authorize(
    owner: string,
    sessionId: string,
    permission = 'sessions.run',
  ) {
    const account = await this.service.options.getAccount(owner)
    requirePermission(account, permission)
    const binding = await this.service.binding(owner, sessionId)
    if (!binding) throw new ApiError(404, '会话未绑定业务智能体')
    // Existing outputs belong to this account/session, independently of a
    // later agent edit or unpublish. New executions still check active grants.
    if (permission === 'files.read') return binding
    if (!binding.resourceOwnerId) {
      const [source] = await this.service.options.db.query(
        'SELECT owner_user_id FROM business_agents WHERE id=$1',
        [binding.definition.id],
      )
      if (!source) throw new ApiError(404, '智能体已不存在')
      binding.resourceOwnerId = text(source.owner_user_id)
      await new AgentResourceService(
        this.service.options,
      ).ensureDefaultsForOwner(binding.resourceOwnerId)
    }
    await this.service.available(account, binding.definition.id, permission)
    const session = await this.service.options.hub.store.session(
      sessionId,
      owner,
    )
    await this.service.options.hub.connectorAllowed(text(session.connector_id))
    if (session.executor_kind !== 'server-agent')
      throw new ApiError(403, '办公助手仅能在本会话的服务端 Agent 上运行')
    await new AgentResourceService(this.service.options).assertActive(
      binding.resourceOwnerId || owner,
      binding.definition.knowledgeBaseIds ?? [],
      binding.skills?.map((skill) => skill.id) ?? binding.definition.skillIds,
      binding.definition.toolIds,
    )
    return binding
  }

  async read(account: Account, sessionId: string, id: string) {
    await this.authorize(account.userId, sessionId, 'files.read')
    await this.recoverInterrupted(account.userId, sessionId)
    const [row] = await this.service.options.db.query(
      'SELECT plan_json FROM business_office_plans WHERE id=$1 AND session_id=$2 AND owner_user_id=$3',
      [id, sessionId, account.userId],
    )
    if (!row) throw new ApiError(404, '办公方案不存在')
    return json<OfficePlan>(row.plan_json, {} as OfficePlan)
  }

  async list(account: Account, sessionId: string) {
    await this.authorize(account.userId, sessionId, 'files.read')
    await this.recoverInterrupted(account.userId, sessionId)
    const rows = await this.service.options.db.query(
      'SELECT plan_json FROM business_office_plans WHERE session_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC LIMIT 100',
      [sessionId, account.userId],
    )
    return {
      items: rows.map((row) =>
        json<OfficePlan>(row.plan_json, {} as OfficePlan),
      ),
    }
  }

  async prepare(
    owner: string,
    binding: AgentBinding,
    tool: OfficePlan['tool'],
    args: Row,
    context: AgentToolContext,
    signal: AbortSignal,
  ): Promise<Row> {
    if (!binding.definition.toolIds.includes(tool))
      throw new ApiError(403, '工具未授权')
    let previous = args.planId
      ? await this.read(
          await this.service.options.getAccount(owner),
          binding.sessionId,
          text(args.planId),
        )
      : undefined
    if (!previous && args.previousArtifactId) {
      const [row] = await this.service.options.db.query(
        'SELECT metadata_json FROM business_agent_artifacts WHERE id=$1 AND session_id=$2',
        [text(args.previousArtifactId), binding.sessionId],
      )
      if (!row) throw new ApiError(404, '成果不属于当前会话')
      const metadata = json<Row>(row.metadata_json, {})
      const planId = text(record(metadata.revision).planId)
      if (!planId)
        throw new ApiError(422, '旧成果缺少可修订结构，请上传并重新制定方案')
      previous = await this.read(
        await this.service.options.getAccount(owner),
        binding.sessionId,
        planId,
      )
    }
    if (previous && previous.tool !== tool)
      throw new ApiError(422, '不能改变方案类型')
    const sources =
      previous &&
      !args.inputs &&
      !args.inputsJson &&
      !args.dataAssetId &&
      !args.attachmentName
        ? await loadOfficeSources(
            this.service,
            owner,
            binding,
            previous.sources,
          )
        : await resolveOfficeSources(
            this.service,
            owner,
            binding,
            args,
            context,
            signal,
          )
    if (context.phase === 'inspect')
      return {
        inspection: await managedToolWork(
          this.service,
          owner,
          binding,
          tool,
          'inspect',
          sources,
          null,
          signal,
        ),
        sources: sources.map((item) => item.reference),
        ...(previous
          ? {
              previousPlan: {
                id: previous.id,
                sha256: previous.sha256,
                document: previous.document,
                artifactId: previous.artifactId,
              },
            }
          : {}),
        note: '根据检查结果编写方案，不要猜测字段或自动选用演示资料。',
      }
    let document = officeJson(
      args.planJson ?? args.document ?? previous?.document,
      '办公方案',
    )
    if (!document || typeof document !== 'object' || Array.isArray(document))
      throw new ApiError(422, '请先检查输入，再提交明确的办公方案')
    if (record(document).patch !== undefined) {
      if (!previous)
        throw new ApiError(
          422,
          '按页或章节修订必须指定 planId 或 previousArtifactId',
        )
      document = reviseDocumentStructure(
        previous.document,
        record(document).patch,
        previous.sha256,
      )
    }
    const prepared = await managedToolWork(
      this.service,
      owner,
      binding,
      tool,
      'prepare',
      sources,
      document,
      signal,
    )
    const normalized = record(prepared.document)
    const previousArtifactId =
      text(
        args.previousArtifactId ||
          previous?.artifactId ||
          previous?.previousArtifactId,
      ) || undefined
    if (previousArtifactId) {
      const [artifact] = await this.service.options.db.query(
        'SELECT id FROM business_agent_artifacts WHERE id=$1 AND session_id=$2',
        [previousArtifactId, binding.sessionId],
      )
      if (!artifact) throw new ApiError(404, '要修改的成果不属于本会话')
    }
    signal.throwIfAborted()
    const id = `plan_${officeHash(`${owner}:${binding.sessionId}:${context.callId}`).slice(0, 40)}`
    const token = randomBytes(32).toString('hex')
    const plan = await this.service.options.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        id,
      ])
      const [old] = await db.query(
        'SELECT plan_json FROM business_office_plans WHERE id=$1 FOR UPDATE',
        [id],
      )
      const oldPlan = old
        ? json<OfficePlan>(old.plan_json, {} as OfficePlan)
        : undefined
      if (oldPlan?.state === 'completed') return oldPlan
      if (oldPlan?.state === 'running')
        throw new ApiError(409, '此方案仍在执行，不能覆盖')
      const now = utcNow()
      const value: OfficePlan = {
        ...(context.skillRunId
          ? {
              skillRunId: context.skillRunId,
              skillRevision: context.skillRevision,
            }
          : {}),
        id,
        sessionId: binding.sessionId,
        bindingVersion: binding.bindingVersion ?? 1,
        agentDefinition: {
          id: binding.definition.id,
          name: binding.definition.name,
          version: binding.definition.version,
        },
        tool,
        version: (oldPlan?.version ?? 0) + 1,
        title: text(
          normalized.title,
          binding.tools?.find((item) => item.id === tool)?.name ?? '执行方案',
        ),
        document: normalized,
        sources: sources.map((item) => item.reference),
        previousArtifactId,
        sha256: '',
        summary: '',
        warnings: warningsFrom(prepared.preflight),
        state: 'prepared',
        createdAt: oldPlan?.createdAt ?? now,
        updatedAt: now,
      }
      value.sha256 = officePlanHash({
        document: value.document,
        sources: value.sources,
        previousArtifactId,
      })
      value.summary = officePlanSummary(value)
      await db.query(
        'INSERT INTO business_office_plans(id,owner_user_id,session_id,call_id,version,plan_json,approval_hash,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,plan_json=EXCLUDED.plan_json,approval_hash=EXCLUDED.approval_hash,updated_at=EXCLUDED.updated_at',
        [
          id,
          owner,
          binding.sessionId,
          context.callId,
          value.version,
          JSON.stringify(value),
          officeHash(token),
          value.createdAt,
          now,
        ],
      )
      return value
    })
    if (plan.state === 'completed')
      return plan.result ?? this.completed(binding.sessionId, plan.artifactId!)
    return {
      plan,
      confirmation: {
        planId: id,
        version: plan.version,
        sha256: plan.sha256,
        token,
      } satisfies OfficeConfirmation,
    }
  }

  async revise(
    account: Account,
    sessionId: string,
    id: string,
    body: Row,
    signal: AbortSignal,
  ) {
    const binding = await this.authorize(
      account.userId,
      sessionId,
      'files.write',
    )
    const plan = await this.read(account, sessionId, id)
    if ((plan.bindingVersion ?? 1) !== (binding.bindingVersion ?? 1))
      throw new ApiError(409, '此方案属于旧智能体绑定，请在当前对话提出新方案')
    if (
      body.version !== plan.version ||
      plan.state === 'completed' ||
      plan.state === 'running'
    )
      throw new ApiError(
        409,
        '方案已改变或已执行，请重新读取或提出新的修改任务',
      )
    const sources = await loadOfficeSources(
      this.service,
      account.userId,
      binding,
      plan.sources,
    )
    const prepared = await managedToolWork(
      this.service,
      account.userId,
      binding,
      plan.tool,
      'prepare',
      sources,
      body.document,
      signal,
    )
    plan.document = record(prepared.document)
    plan.title = text(plan.document.title)
    plan.warnings = warningsFrom(prepared.preflight)
    plan.sha256 = officePlanHash({
      document: plan.document,
      sources: plan.sources,
      previousArtifactId: plan.previousArtifactId,
    })
    plan.version += 1
    plan.state = 'prepared'
    plan.updatedAt = utcNow()
    plan.summary = officePlanSummary(plan)
    const rows = await this.service.options.db.query(
      "UPDATE business_office_plans SET version=$4,plan_json=$5,approval_hash=$6,updated_at=$7 WHERE id=$1 AND session_id=$2 AND owner_user_id=$3 AND version=$8 AND plan_json::jsonb->>'state' NOT IN ('completed','running') RETURNING id",
      [
        id,
        sessionId,
        account.userId,
        plan.version,
        JSON.stringify(plan),
        officeHash(randomBytes(32)),
        plan.updatedAt,
        body.version,
      ],
    )
    if (!rows.length) throw new ApiError(409, '方案被其他操作修改，请刷新')
    return { plan, note: '方案已修改，请让助手重新展示并确认；旧确认已失效。' }
  }

  private async completed(
    sessionId: string,
    artifactId: string,
    db: SqlConnection = this.service.options.db,
  ): Promise<Row> {
    const [row] = await db.query(
      'SELECT metadata_json FROM business_agent_artifacts WHERE id=$1 AND session_id=$2',
      [artifactId, sessionId],
    )
    if (!row) throw new ApiError(409, '成果提交未完成，请重试原方案')
    return {
      artifact: json<Row>(row.metadata_json, {}),
      note: '文件已生成，可在本会话生成成果区域预览或下载。',
    }
  }

  private async recoverInterrupted(owner: string, sessionId: string) {
    await this.service.options.db.transaction(async (db) => {
      const rows = await db.query(
        "UPDATE agent_tool_runs SET state='interrupted',error=$4,updated_at=$3 WHERE owner_user_id=$1 AND session_id=$2 AND state='running' AND lease_expires_at<$3 RETURNING plan_id",
        [
          owner,
          sessionId,
          utcNow(),
          '执行进程已中断，未自动重放。请检查已产生的外部结果后重新确认新方案。',
        ],
      )
      for (const row of rows) {
        const [saved] = await db.query(
          'SELECT plan_json FROM business_office_plans WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',
          [row.plan_id, owner],
        )
        if (!saved) continue
        const plan = json<OfficePlan>(saved.plan_json, {} as OfficePlan)
        if (plan.state !== 'running') continue
        plan.state = 'interrupted'
        plan.error = '执行进程已中断，未自动重放。请检查外部结果后创建新方案。'
        plan.updatedAt = utcNow()
        await db.query(
          'UPDATE business_office_plans SET plan_json=$2,updated_at=$3 WHERE id=$1',
          [row.plan_id, JSON.stringify(plan), plan.updatedAt],
        )
      }
    })
  }

  async execute(
    owner: string,
    binding: AgentBinding,
    tool: string,
    context: AgentToolContext,
    signal: AbortSignal,
  ): Promise<Row> {
    await this.recoverInterrupted(owner, binding.sessionId)
    const key = canonical([
      owner,
      binding.sessionId,
      tool,
      context.callId,
      context.confirmation,
    ])
    let active = executing.get(this.service)
    if (!active) executing.set(this.service, (active = new Map()))
    const previous = active.get(key)
    if (previous) return previous
    const operation = this.executeOnce(owner, binding, tool, context, signal)
    active.set(key, operation)
    try {
      return await operation
    } finally {
      if (active.get(key) === operation) active.delete(key)
    }
  }

  private async notify(owner: string, sessionId: string) {
    const session = await this.service.options.hub.store.session(
      sessionId,
      owner,
    )
    this.service.options.hub.emit(
      sessionId,
      Number(session.seq || 0),
      'session.refetch_required',
      { reason: 'office.updated' },
    )
  }

  private async executeOnce(
    owner: string,
    binding: AgentBinding,
    tool: string,
    context: AgentToolContext,
    signal: AbortSignal,
  ): Promise<Row> {
    const approval = context.confirmation
    if (!approval) throw new ApiError(409, '需要用户确认当前方案后才能执行')
    const db = this.service.options.db
    const lease = randomBytes(24).toString('hex')
    let claimed = false
    let plan: OfficePlan | undefined
    try {
      const claim = await db.transaction(async (connection) => {
        const [row] = await connection.query(
          'SELECT * FROM business_office_plans WHERE id=$1 AND owner_user_id=$2 AND session_id=$3 FOR UPDATE',
          [approval.planId, owner, binding.sessionId],
        )
        if (!row || row.call_id !== context.callId)
          throw new ApiError(403, '办公确认不属于本次执行')
        const value = json<OfficePlan>(row.plan_json, {} as OfficePlan)
        if (
          value.skillRunId !== context.skillRunId ||
          value.skillRevision !== context.skillRevision
        )
          throw new ApiError(409, '技能已修订，旧方案确认不能继续执行')
        if ((value.bindingVersion ?? 1) !== (binding.bindingVersion ?? 1))
          throw new ApiError(409, '智能体已切换，旧方案不能批准当前任务')
        const expected = text(row.approval_hash),
          actual = officeHash(approval.token)
        if (
          value.tool !== tool ||
          value.version !== approval.version ||
          value.sha256 !== approval.sha256 ||
          expected.length !== actual.length ||
          !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
        )
          throw new ApiError(
            409,
            '方案已改变，请重新检查并确认，旧确认不能继续执行',
          )
        if (value.state === 'completed') return { value, completed: true }
        const [running] = await connection.query(
          'SELECT * FROM agent_tool_runs WHERE id=$1 FOR UPDATE',
          [value.id],
        )
        if (running?.state === 'running') {
          if (String(running.lease_expires_at) > utcNow())
            throw new ApiError(
              409,
              '此方案正在执行，请稍后查看结果，不要重复提交',
            )
          throw new ApiError(
            409,
            '之前的执行已中断，不能自动重放；请创建新方案并确认',
          )
        }
        if (
          ['interrupted', 'failed', 'timed-out', 'cancelled'].includes(
            value.state,
          )
        )
          throw new ApiError(
            409,
            '此执行未完成，请重新检查并确认新方案，旧确认不能重放可能产生费用的调用',
          )
        value.state = 'running'
        value.stage = 'generating'
        value.updatedAt = utcNow()
        await connection.query(
          "INSERT INTO agent_tool_runs(id,owner_user_id,session_id,plan_id,state,stage,lease_token,lease_expires_at,created_at,updated_at) VALUES($1,$2,$3,$1,'running','generating',$4,$5,$6,$6) ON CONFLICT(id) DO UPDATE SET state='running',stage='generating',lease_token=EXCLUDED.lease_token,lease_expires_at=EXCLUDED.lease_expires_at,updated_at=EXCLUDED.updated_at",
          [
            value.id,
            owner,
            binding.sessionId,
            lease,
            new Date(Date.now() + 15 * 60000).toISOString(),
            value.updatedAt,
          ],
        )
        await connection.query(
          'UPDATE business_office_plans SET plan_json=$2,updated_at=$3 WHERE id=$1',
          [value.id, JSON.stringify(value), value.updatedAt],
        )
        return { value, completed: false }
      })
      plan = claim.value
      if (claim.completed)
        return (
          plan.result ?? this.completed(binding.sessionId, plan.artifactId!)
        )
      claimed = true
      await this.authorize(owner, binding.sessionId)
      await this.notify(owner, binding.sessionId)
      const registered = await resolveManagedTool(
        this.service,
        owner,
        binding,
        tool,
      )
      const sources = await loadOfficeSources(
        this.service,
        owner,
        binding,
        plan.sources,
      )
      signal.throwIfAborted()
      // Work, network calls and rendering never hold the database transaction.
      const result = await managedToolWork(
        this.service,
        owner,
        binding,
        tool,
        'generate',
        sources,
        plan.document,
        signal,
        `${plan.id}:${plan.version}:${plan.sha256}`,
      )
      signal.throwIfAborted()
      await this.authorize(owner, binding.sessionId)
      const external = record(result.toolResult)
      const rawArtifacts = Array.isArray(external.artifacts)
        ? external.artifacts
        : []
      const outputs: {
        content: Buffer
        filename: string
        mediaType: string
      }[] = result.content
        ? [
            {
              content: Buffer.from(result.content as Uint8Array),
              filename: text(result.filename),
              mediaType: text(result.mediaType),
            },
          ]
        : rawArtifacts.map((raw) => {
            const artifact = record(raw)
            const encoded = text(artifact.contentBase64)
            if (encoded.length > 32 * 1024 * 1024)
              throw new ApiError(413, '扩展成果文件过大')
            const content = Buffer.from(encoded, 'base64')
            if (content.toString('base64') !== encoded)
              throw new ApiError(422, '扩展成果编码无效')
            return {
              content,
              filename: text(artifact.name),
              mediaType: text(artifact.mediaType),
            }
          })
      if (outputs.length > 20)
        throw new ApiError(413, '一次工具调用最多返回 20 个成果')
      const revision: ArtifactRevision = {
        ...(context.skillRunId
          ? {
              skillRunId: context.skillRunId,
              skillRevision: context.skillRevision,
            }
          : {}),
        planId: plan.id,
        planVersion: plan.version,
        planHash: plan.sha256,
        previousArtifactId: plan.previousArtifactId,
        inputSources: plan.sources,
        agentVersion: binding.definition.version,
        bindingVersion: binding.bindingVersion ?? 1,
        skillVersions: (binding.skills ?? []).map(({ id, version }) => ({
          id,
          version,
        })),
        toolVersions: (binding.tools ?? []).map(({ id, version }) => ({
          id,
          version,
        })),
        dependencies: [registered.implementation],
      }
      const artifacts: { id: string; metadata: Row }[] = []
      for (const [index, file] of outputs.entries()) {
        requirePermission(
          await this.service.options.getAccount(owner),
          'files.write',
        )
        if (!registered.descriptor.artifactTypes.includes(file.mediaType))
          throw new ApiError(422, '工具返回了未声明的成果类型')
        if (
          !file.content.length ||
          !file.filename ||
          /[\\/:*?"<>|\x00-\x1f]/u.test(file.filename)
        )
          throw new ApiError(422, '成果文件名或内容无效')
        const artifactId =
          'artifact_' +
          officeHash(
            plan.id +
              ':' +
              plan.version +
              ':' +
              plan.sha256 +
              (index ? ':' + index : ''),
          ).slice(0, 40)
        let output: Row = {
          origin: 'agent',
          tool,
          revision,
          diagnostics: warningsFrom(result),
          summary: result.summary ?? result.sheets ?? result.pages ?? null,
          agentDefinition: {
            id: binding.definition.id,
            name: binding.definition.name,
            version: binding.definition.version,
          },
        }
        if (/\.(pptx|docx)$/iu.test(file.filename)) {
          plan.stage = 'rendering'
          plan.updatedAt = utcNow()
          await db.query(
            'UPDATE business_office_plans SET plan_json=$2,updated_at=$3 WHERE id=$1 AND version=$4',
            [plan.id, JSON.stringify(plan), plan.updatedAt, plan.version],
          )
          await this.notify(owner, binding.sessionId)
          const render = () =>
            renderAndCacheArtifactPreview(this.service, {
              owner,
              sessionId: binding.sessionId,
              artifactId,
              file: { filename: file.filename, content: file.content },
              signal,
              authorize: () =>
                this.authorize(owner, binding.sessionId, 'files.write'),
            })
          let preview = await render()
          // Only deterministic typography repairs; never rerun an extension or a paid image call.
          for (
            let round = 1;
            round <= 2 && preview.quality?.status === 'draft';
            round++
          ) {
            const repaired = await repairRenderedDocument(
              { filename: file.filename, content: file.content },
              preview.quality,
              round,
            )
            if (!repaired) break
            signal.throwIfAborted()
            file.content = repaired
            preview = await render()
            if (preview.quality) preview.quality.correctionRounds = round
          }
          output = withArtifactPreview(output, preview)
        }
        const saved = await this.service.options.files.save(
          owner,
          binding.sessionId,
          file.filename,
          file.content,
          file.mediaType,
          artifactId,
          index === 0 ? plan.previousArtifactId : undefined,
        )
        output = { ...saved, ...output }
        artifacts.push({ id: artifactId, metadata: output })
      }
      signal.throwIfAborted()
      await this.authorize(owner, binding.sessionId)
      await resolveManagedTool(this.service, owner, binding, tool)
      const { artifacts: _encodedArtifacts, ...toolResult } = external
      const returned: Row = {
        ...(artifacts.length
          ? {
              artifact: artifacts[0]!.metadata,
              artifacts: artifacts.map((item) => item.metadata),
            }
          : {}),
        ...(result.toolResult ? { toolResult } : {}),
        note: artifacts.some((item) => item.metadata.draft === true)
          ? '原文件已保留，但实际渲染检查未通过，请查看诊断；当前成果为草稿。'
          : artifacts.length
            ? '文件已生成，可在本会话预览、下载或提出修改。'
            : '工具已完成。',
      }
      plan.state = 'completed'
      plan.stage = 'complete'
      plan.artifactId = artifacts[0]?.id
      plan.result = returned
      plan.updatedAt = utcNow()
      delete plan.error
      await db.transaction(async (connection) => {
        const [active] = await connection.query(
          "SELECT id FROM agent_tool_runs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
          [plan!.id, lease],
        )
        if (!active) throw new ApiError(409, '工具执行归属已改变，结果未提交')
        for (const artifact of artifacts)
          await connection.query(
            'INSERT INTO business_agent_artifacts(id,session_id,metadata_json,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET metadata_json=EXCLUDED.metadata_json',
            [
              artifact.id,
              binding.sessionId,
              JSON.stringify(artifact.metadata),
              plan!.updatedAt,
            ],
          )
        await connection.query(
          'UPDATE business_office_plans SET plan_json=$2,updated_at=$3 WHERE id=$1 AND version=$4',
          [plan!.id, JSON.stringify(plan), plan!.updatedAt, plan!.version],
        )
        await connection.query(
          "UPDATE agent_tool_runs SET state='completed',stage='complete',result_json=$3,updated_at=$4 WHERE id=$1 AND lease_token=$2",
          [plan!.id, lease, JSON.stringify(returned), plan!.updatedAt],
        )
        await this.service.options.audit(
          owner,
          'agent.tool.complete',
          plan!.id,
          {
            sessionId: binding.sessionId,
            tool,
            planHash: plan!.sha256,
            artifactIds: artifacts.map((item) => item.id),
          },
          connection,
        )
      })
      await this.notify(owner, binding.sessionId)
      return returned
    } catch (error) {
      if (claimed && plan) {
        const reason = signal.reason instanceof ApiError ? signal.reason : error
        const timedOut = reason instanceof ApiError && reason.status === 504
        plan.state = timedOut
          ? 'timed-out'
          : signal.aborted
            ? 'cancelled'
            : 'failed'
        plan.error =
          reason instanceof ApiError
            ? reason.message
            : '工具执行失败，请检查方案及工具诊断'
        plan.updatedAt = utcNow()
        await db.transaction(async (connection) => {
          const [active] = await connection.query(
            "UPDATE agent_tool_runs SET state=$3,error=$4,updated_at=$5 WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id",
            [plan!.id, lease, plan!.state, plan!.error, plan!.updatedAt],
          )
          if (active)
            await connection.query(
              "UPDATE business_office_plans SET plan_json=$2,updated_at=$3 WHERE id=$1 AND version=$4 AND plan_json::jsonb->>'state' <> 'completed'",
              [plan!.id, JSON.stringify(plan), plan!.updatedAt, plan!.version],
            )
        })
        await this.notify(owner, binding.sessionId).catch(() => {})
      }
      throw error
    }
  }
}
