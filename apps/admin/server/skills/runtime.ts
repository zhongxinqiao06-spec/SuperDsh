import { createHash, randomUUID } from 'node:crypto'
import type {
  SkillRun,
  SkillCheckResult,
} from '@superdsh/core/contracts/skills'
import {
  ApiError,
  object,
  requiredText,
  text,
  utcNow,
  type Account,
} from '../http/api-router.ts'
import {
  json,
  type Row,
  type SqlConnection,
} from '../infrastructure/database.ts'
import type { BusinessAgentService } from '../agents/service.ts'
import type { AgentBinding, AgentToolContext } from '../agents/contracts.ts'
import { OfficePlanService } from '../agents/office-plans.ts'
import { validateValue } from '../extensions/validation.ts'
import { matchSkills } from './matching.ts'

export const skillControlTool = 'superdsh_skill'
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const activeStates = ['running', 'waiting-user', 'needs-revision']
const stageFor = (run: SkillRun) => run.stages[run.stageIndex]!
const readRun = (row: Row) => json<SkillRun>(row.run_json, {} as SkillRun)

/** A persisted gate around DSH calls; never schedules a model or tool itself. */
export class SkillRuntime {
  readonly service: BusinessAgentService
  constructor(service: BusinessAgentService) {
    this.service = service
  }

  /** Called only after taking the platform's exclusive database lease. Never replays work. */
  async recoverAfterRestart() {
    const pending = await this.service.options.db.query(
      "SELECT id FROM agent_skill_runs WHERE state IN ('running','waiting-user','needs-revision')",
    )
    for (const { id } of pending) {
      await this.service.options.db.transaction(async (db) => {
        const [row] = await db.query(
          'SELECT * FROM agent_skill_runs WHERE id=$1 FOR UPDATE',
          [id],
        )
        if (!row || !activeStates.includes(String(row.state))) return
        const run = readRun(row)
        run.state = 'interrupted'
        const stage = stageFor(run)
        stage.state = 'interrupted'
        stage.error =
          '平台执行进程已重启；已完成阶段和成果保留。请明确继续并重新确认方案，不会自动重放工具。'
        stage.endedAt = utcNow()
        await db.query(
          'UPDATE agent_skill_runs SET claimed_call=NULL,claim_expires_at=NULL WHERE id=$1',
          [id],
        )
        await this.store(
          db,
          String(row.owner_user_id),
          run,
          'platform-restarted',
        )
      })
    }
  }

  enabled(binding: AgentBinding) {
    return (
      !!binding.definition.skillPolicy &&
      binding.definition.skillPolicy.mode !== 'legacy'
    )
  }

  async settled(owner: string, context: AgentToolContext, reason: string) {
    const binding = await this.service.binding(owner, context.sessionId)
    if (
      !binding ||
      !this.enabled(binding) ||
      binding.presetId !== context.presetId ||
      (binding.bindingVersion ?? 1) !== (context.bindingVersion ?? 1)
    )
      return
    await this.service.options.db.transaction(async (db) => {
      const row = await this.latest(owner, binding, db, true)
      if (!row) return
      const run = readRun(row)
      if (
        !activeStates.includes(run.state) ||
        (run.activeRequestId ?? run.requestId) !== context.requestId
      )
        return
      // A terminal DSH event is evidence that this turn stopped, not that its skill passed.
      run.state =
        reason === 'aborted'
          ? 'cancelled'
          : reason === 'completed' || reason === 'blocked'
            ? 'needs-revision'
            : 'interrupted'
      const stage = stageFor(run)
      stage.state = run.state
      stage.error =
        run.state === 'cancelled'
          ? '用户停止了当前 DSH 回合，未完成阶段不会自动重放。'
          : 'DSH 回合已结束，但技能尚未完成全部校验；可从当前记录继续修订。'
      stage.endedAt = utcNow()
      await db.query(
        'UPDATE agent_skill_runs SET claimed_call=NULL,claim_expires_at=NULL WHERE id=$1',
        [run.id],
      )
      await this.store(db, owner, run, 'turn-settled')
    })
    await this.notify(owner, binding.sessionId)
  }

  async list(account: Account, sessionId: string) {
    await new OfficePlanService(this.service).authorize(
      account.userId,
      sessionId,
      'files.read',
    )
    await this.recover(account.userId, sessionId)
    const rows = await this.service.options.db.query(
      'SELECT run_json FROM agent_skill_runs WHERE owner_user_id=$1 AND session_id=$2 ORDER BY created_at DESC LIMIT 100',
      [account.userId, sessionId],
    )
    return { items: rows.map(readRun) }
  }

  async read(account: Account, sessionId: string, runId: string) {
    await new OfficePlanService(this.service).authorize(
      account.userId,
      sessionId,
      'files.read',
    )
    await this.recover(account.userId, sessionId)
    const [row] = await this.service.options.db.query(
      'SELECT run_json FROM agent_skill_runs WHERE owner_user_id=$1 AND session_id=$2 AND id=$3',
      [account.userId, sessionId, runId],
    )
    if (!row) throw new ApiError(404, '技能运行记录不存在')
    return { run: readRun(row) }
  }

  private async notify(owner: string, session: string) {
    const row = await this.service.options.hub.store.session(session, owner)
    this.service.options.hub.emit(
      session,
      Number(row.seq || 0),
      'session.refetch_required',
      { reason: 'skills.updated' },
    )
  }

  private async store(
    db: SqlConnection,
    owner: string,
    run: SkillRun,
    kind: string,
  ) {
    run.version++
    run.updatedAt = utcNow()
    await db.query(
      'UPDATE agent_skill_runs SET state=$3,version=$4,run_json=$5,updated_at=$6 WHERE id=$1 AND owner_user_id=$2',
      [
        run.id,
        owner,
        run.state,
        run.version,
        JSON.stringify(run),
        run.updatedAt,
      ],
    )
    await db.query(
      'INSERT INTO agent_skill_events(id,run_id,version,kind,event_json,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        run.id,
        run.version,
        kind,
        JSON.stringify({
          state: run.state,
          stageIndex: run.stageIndex,
          revision: run.revision,
          stage: run.stages[run.stageIndex] ?? null,
        }),
        run.updatedAt,
      ],
    )
  }

  private async recover(owner: string, session: string) {
    await this.service.options.db.transaction(async (db) => {
      const rows = await db.query(
        'SELECT * FROM agent_skill_runs WHERE owner_user_id=$1 AND session_id=$2 AND claimed_call IS NOT NULL AND claim_expires_at<$3 FOR UPDATE',
        [owner, session, utcNow()],
      )
      for (const row of rows) {
        const run = readRun(row)
        run.state = 'interrupted'
        stageFor(run).state = 'interrupted'
        stageFor(run).error =
          'Host 执行归属已过期；请检查已有结果后明确修订，不会自动重放工具。'
        await db.query(
          'UPDATE agent_skill_runs SET claimed_call=NULL,claim_expires_at=NULL WHERE id=$1',
          [run.id],
        )
        await this.store(db, owner, run, 'interrupted')
      }
    })
  }

  private async latest(
    owner: string,
    binding: AgentBinding,
    db: SqlConnection,
    lock = false,
  ) {
    const [row] = await db.query(
      `SELECT * FROM agent_skill_runs WHERE owner_user_id=$1 AND session_id=$2 AND binding_version=$3 ORDER BY created_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [owner, binding.sessionId, binding.bindingVersion ?? 1],
    )
    return row
  }

  private view(run: SkillRun, binding: AgentBinding) {
    const definition = run.program.stages[run.stageIndex]
    const helper = binding.skills?.find(
      (skill) => skill.id === definition?.skillId,
    )
    const stageSummary = ({
      output: _output,
      ...stage
    }: SkillRun['stages'][number]) => ({
      ...stage,
      calls: stage.calls.map(({ output: _result, ...call }) => call),
    })
    const { program: _program, stages, history, ...summary } = run
    return {
      run: {
        ...summary,
        stages: stages.map(stageSummary),
        history: history.map(stageSummary),
      },
      previousOutput: stages[Math.max(0, run.stageIndex - 1)]?.output ?? null,
      auxiliaryResults:
        stages[run.stageIndex]?.calls
          .filter((call) => call.auxiliary && call.state === 'completed')
          .slice(-10)
          .map(({ tool, phase, output }) => ({ tool, phase, output })) ?? [],
      currentStage: definition
        ? {
            ...definition,
            instructions: [helper?.instructions, definition.instructions]
              .filter(Boolean)
              .join('\n\n'),
          }
        : null,
      note: '仅执行 currentStage。submit 阶段可按需调用 toolIds 中的辅助工具；inspectToolIds 只允许 inspect。辅助调用不推进阶段，完成后提交结构化结果。所有 plan 仍由 Host 确认后执行；不能跳阶段或虚报校验通过。',
    }
  }

  async control(
    owner: string,
    binding: AgentBinding,
    args: Row,
    context: AgentToolContext,
  ) {
    if (!this.enabled(binding))
      throw new ApiError(422, '此会话尚未启用分阶段技能')
    if (!context.requestId || context.requestText === undefined)
      throw new ApiError(403, '缺少 Host 提供的用户请求')
    const requestId = context.requestId,
      requestText = context.requestText
    await this.recover(owner, binding.sessionId)
    const candidates = matchSkills(
      binding.skills ?? [],
      context.requestText,
      context.inputExtensions ?? [],
      binding.definition.skillPolicy,
    )
    if (args.action === 'match')
      return {
        candidates,
        request: context.requestText,
        note: '选择适合当前用户任务的已授权技能。score 是词项匹配计分，不是置信度。歧义先向用户确认；普通问答无需启动。',
      }
    if (args.action === 'status') {
      const row = await this.latest(owner, binding, this.service.options.db)
      return row ? this.view(readRun(row), binding) : { run: null, candidates }
    }
    const result = await this.service.options.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `skill-run:${owner}:${binding.sessionId}`,
      ])
      const row = await this.latest(owner, binding, db, true)
      if (args.action === 'start') {
        const skill = binding.skills?.find(
          (entry) =>
            entry.id === args.skillId &&
            binding.definition.skillIds.includes(entry.id),
        )
        const candidate = candidates.find((entry) => entry.id === args.skillId)
        if (!skill?.program || !candidate || candidate.score < 0)
          throw new ApiError(403, '技能不在本次可用范围内')
        if (row) {
          const current = readRun(row)
          if (activeStates.includes(current.state)) {
            if (current.skillId !== skill.id)
              throw new ApiError(409, '已有未结束技能，请先完成或明确取消')
            return this.view(current, binding)
          }
        }
        const [prior] = await db.query(
          'SELECT run_json FROM agent_skill_runs WHERE owner_user_id=$1 AND session_id=$2 AND request_id=$3',
          [owner, binding.sessionId, context.requestId],
        )
        if (prior) return this.view(readRun(prior), binding)
        const now = utcNow()
        const run: SkillRun = {
          id: 'skillrun_' + randomUUID().replaceAll('-', ''),
          sessionId: binding.sessionId,
          bindingVersion: binding.bindingVersion ?? 1,
          skillId: skill.id,
          skillName: skill.name,
          skillVersion: skill.version,
          requestId,
          request: requestText.slice(0, 12000),
          version: 0,
          revision: 1,
          state: 'running',
          stageIndex: 0,
          program: skill.program,
          stages: skill.program.stages.map((stage, index) => ({
            id: stage.id,
            name: stage.name,
            operation: stage.operation,
            skillId: stage.skillId || skill.id,
            skillVersion:
              binding.skills?.find((entry) => entry.id === stage.skillId)
                ?.version ?? skill.version,
            attempt: 1,
            state: index === 0 ? 'running' : 'pending',
            checks: [],
            calls: [],
            ...(index === 0 ? { startedAt: now } : {}),
          })),
          history: [],
          selection: {
            reason: requiredText(args.reason, '技能选择理由', 500),
            candidates: candidates.map(({ id, name, score, reasons }) => ({
              id,
              name,
              score,
              reasons,
            })),
          },
          createdAt: now,
          updatedAt: now,
        }
        await db.query(
          'INSERT INTO agent_skill_runs(id,owner_user_id,session_id,binding_version,request_id,state,version,run_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$8)',
          [
            run.id,
            owner,
            binding.sessionId,
            run.bindingVersion,
            run.requestId,
            run.state,
            JSON.stringify(run),
            now,
          ],
        )
        await this.store(db, owner, run, 'started')
        return this.view(run, binding)
      }
      if (!row) throw new ApiError(409, '请先匹配并启动技能')
      const run = readRun(row)
      if (args.runId !== run.id || args.version !== run.version)
        throw new ApiError(409, '技能阶段已变化，请重新读取状态')
      if (row.claimed_call) throw new ApiError(409, '当前阶段工具仍在运行')
      if (args.action === 'cancel') {
        if (context.requestId === (run.activeRequestId ?? run.requestId))
          throw new ApiError(
            409,
            '结束技能需要用户新的明确请求，不能自行放弃任务',
          )
        if (run.state === 'completed')
          throw new ApiError(409, '已完成技能无需取消')
        run.state = 'cancelled'
        const stage = stageFor(run)
        stage.state = 'cancelled'
        stage.error = '用户明确结束了未完成技能，历史阶段与成果保留。'
        stage.endedAt = utcNow()
        await this.store(db, owner, run, 'cancelled-by-request')
        return this.view(run, binding)
      }
      if (args.action === 'revise') {
        if (run.revision > run.program.maxRevisions)
          throw new ApiError(409, '已达到修订上限，请明确开始新任务')
        const index = run.program.stages.findIndex(
          (stage) => stage.id === args.stageId,
        )
        if (
          index < 0 ||
          index > run.stageIndex ||
          ['execute', 'review'].includes(run.program.stages[index]!.operation)
        )
          throw new ApiError(
            422,
            '请从输入、策划、排版或新方案阶段修订，不能复用旧确认直接生成',
          )
        if (
          context.requestId === (run.activeRequestId ?? run.requestId) &&
          ['cancelled', 'interrupted', 'timed-out'].includes(run.state)
        )
          throw new ApiError(409, '中断或取消后需要用户新的明确请求')
        run.history.push(...run.stages.slice(index))
        run.stages = run.stages.map((stage, i) =>
          i < index
            ? stage
            : {
                id: stage.id,
                name: stage.name,
                operation: stage.operation,
                skillId: stage.skillId,
                skillVersion: stage.skillVersion,
                attempt: stage.attempt + 1,
                state: i === index ? 'running' : 'pending',
                checks: [],
                calls: [],
                ...(i === index ? { startedAt: utcNow() } : {}),
              },
        )
        run.stageIndex = index
        run.revision++
        run.activeRequestId = context.requestId
        run.state = 'running'
        await this.store(db, owner, run, 'revised')
        return this.view(run, binding)
      }
      if (args.action !== 'submit') throw new ApiError(422, '无效技能操作')
      const stage = stageFor(run),
        definition = run.program.stages[run.stageIndex]!
      if (
        !activeStates.includes(run.state) ||
        !['submit', 'review'].includes(stage.operation)
      )
        throw new ApiError(
          409,
          '此阶段必须由真实工具执行，不能通过文字提交完成',
        )
      if (
        stage.calls.some(
          (call) =>
            call.auxiliary &&
            call.phase === 'prepare' &&
            call.state === 'completed' &&
            !stage.calls.some(
              (done) =>
                done.auxiliary &&
                done.phase === 'execute' &&
                done.callId === call.callId &&
                done.tool === call.tool &&
                done.state === 'completed',
            ),
        )
      )
        throw new ApiError(
          409,
          '辅助方案尚未完成确认和执行；用户拒绝时请修订当前阶段',
        )
      const output = object(args.output)
      const checks = await this.checks(run, output, db)
      stage.output = output
      stage.checks = checks
      if (checks.some((check) => !check.passed)) {
        stage.state = 'needs-revision'
        run.state = 'needs-revision'
      } else this.advance(run)
      // Definition is read from the frozen program, never from model arguments.
      if (args.stageId !== definition.id)
        throw new ApiError(409, '提交不属于当前阶段')
      await this.store(db, owner, run, 'submitted')
      return this.view(run, binding)
    })
    await this.notify(owner, binding.sessionId)
    return result
  }

  private advance(run: SkillRun) {
    const stage = stageFor(run)
    stage.state = 'completed'
    stage.endedAt = utcNow()
    run.stageIndex++
    if (run.stageIndex === run.stages.length) run.state = 'completed'
    else {
      const next = stageFor(run)
      next.state = next.operation === 'execute' ? 'waiting-user' : 'running'
      next.startedAt = utcNow()
      run.state = next.state
    }
  }

  private async checks(
    run: SkillRun,
    output: Row,
    db: SqlConnection,
  ): Promise<SkillCheckResult[]> {
    const definition = run.program.stages[run.stageIndex]!
    const results: SkillCheckResult[] = []
    const add = (
      validator: string,
      passed: boolean,
      message: string,
      evidence: unknown = output,
    ) =>
      results.push({
        validator,
        version: 1,
        passed,
        message,
        evidenceHash: hash(evidence),
      })
    try {
      validateValue(definition.outputSchema, output, '阶段输出')
      add('schema', true, '输出结构符合已发布配置')
    } catch (error) {
      add('schema', false, error instanceof Error ? error.message : '结构无效')
    }
    for (const check of definition.checks) {
      if (check === 'schema') continue
      if (check === 'sources')
        add(
          check,
          Array.isArray(output.sources),
          '资料由授权解析器读取并记录哈希',
        )
      if (check === 'plan')
        add(
          check,
          !!object(output.plan ?? {}).sha256,
          '方案已通过工具预检并固定版本',
        )
      if (check === 'artifact' || check === 'rendered-quality') {
        const ids = [
          ...new Set(
            run.stages.flatMap((stage) =>
              stage.calls
                .filter((call) => !call.auxiliary)
                .flatMap((call) => call.artifactIds ?? []),
            ),
          ),
        ]
        const rows = ids.length
          ? await db.query(
              'SELECT metadata_json FROM business_agent_artifacts WHERE session_id=$1 AND id=ANY($2::text[])',
              [run.sessionId, ids],
            )
          : []
        const artifacts = rows.map((row) => json<Row>(row.metadata_json, {}))
        // Images are materials, not Office documents. Legacy metadata may lack MIME/name.
        const documents = artifacts.filter(
          (item) =>
            /\.(pptx|docx)$/i.test(String(item.name ?? item.filename ?? '')) ||
            [
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            ].includes(String(item.mediaType)) ||
            (!item.mediaType &&
              !item.name &&
              !item.filename &&
              item.quality !== undefined),
        )
        add(
          check,
          artifacts.length > 0 &&
            (check === 'artifact' ||
              (documents.length > 0 &&
                documents.every(
                  (item) =>
                    !!item.quality &&
                    typeof item.quality === 'object' &&
                    !Array.isArray(item.quality) &&
                    object(item.quality).status === 'passed',
                ))),
          artifacts.length
            ? check === 'artifact'
              ? '成果已保存为当前会话文件'
              : '读取最终成果的实际渲染检查报告'
            : '没有本任务已保存的成果证据',
          artifacts,
        )
      }
    }
    return results
  }

  async beforeTool(
    owner: string,
    binding: AgentBinding,
    tool: string,
    context: AgentToolContext,
  ) {
    if (!this.enabled(binding)) return null
    await this.recover(owner, binding.sessionId)
    return this.service.options.db.transaction(async (db) => {
      const row = await this.latest(owner, binding, db, true)
      if (!row)
        throw new ApiError(409, '请先通过 superdsh_skill 匹配并启动技能')
      const run = readRun(row),
        stage = stageFor(run),
        definition = run.program.stages[run.stageIndex]
      if (!activeStates.includes(run.state) || !stage || !definition)
        throw new ApiError(409, '技能未处于可执行阶段')
      const auxiliary = definition.operation === 'submit'
      const allowed = auxiliary
        ? (definition.toolIds.includes(tool) &&
            ['inspect', 'prepare', 'execute'].includes(context.phase ?? '')) ||
          (context.phase === 'inspect' &&
            (definition.inspectToolIds ?? []).includes(tool))
        : definition.toolIds.includes(tool) &&
          definition.operation === context.phase
      if (!allowed)
        throw new ApiError(
          403,
          `当前阶段“${stage.name}”仅允许 ${definition.operation}：${definition.toolIds.join('、')}`,
        )
      if (row.claimed_call)
        throw new ApiError(409, '当前阶段已有工具调用，请等待完成')
      if (
        auxiliary &&
        stage.calls.some(
          (call) =>
            call.callId === context.callId && call.phase === context.phase,
        )
      )
        throw new ApiError(409, '此辅助调用已有记录，不能重复执行')
      if (!auxiliary && stage.calls.some((call) => call.state === 'completed'))
        throw new ApiError(409, '此阶段已有执行结果，请明确修订，不能重复调用')
      if (context.phase === 'execute') {
        const previous = auxiliary ? stage : run.stages[run.stageIndex - 1]
        if (
          !context.confirmation ||
          !previous?.calls.some(
            (call) =>
              call.planId === context.confirmation!.planId &&
              call.phase === 'prepare' &&
              call.state === 'completed' &&
              call.tool === tool &&
              call.callId === context.callId,
          )
        )
          throw new ApiError(409, '确认不属于当前技能方案或已经失效')
      }
      const claim = `${context.callId}:${context.phase}`
      await db.query(
        'UPDATE agent_skill_runs SET claimed_call=$2,claim_expires_at=$3 WHERE id=$1',
        [
          run.id,
          claim,
          new Date(
            Date.now() + run.program.timeoutSeconds * 1000,
          ).toISOString(),
        ],
      )
      stage.state = 'running'
      run.state = 'running'
      stage.calls.push({
        callId: context.callId,
        tool,
        phase: context.phase || '',
        state: 'running',
        ...(auxiliary ? { auxiliary: true } : {}),
      })
      await this.store(db, owner, run, 'tool-started')
      return {
        runId: run.id,
        revision: run.revision,
        claim,
        stageIndex: run.stageIndex,
        auxiliary,
        timeoutSeconds: run.program.timeoutSeconds,
      }
    })
  }

  async afterTool(
    owner: string,
    binding: AgentBinding,
    ticket: NonNullable<Awaited<ReturnType<SkillRuntime['beforeTool']>>>,
    result?: Row,
    error?: unknown,
  ) {
    await this.service.options.db.transaction(async (db) => {
      const [row] = await db.query(
        'SELECT * FROM agent_skill_runs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',
        [ticket.runId, owner],
      )
      if (!row || row.claimed_call !== ticket.claim)
        throw new ApiError(409, '工具执行归属失效，不能覆盖新阶段')
      const run = readRun(row)
      if (
        run.revision !== ticket.revision ||
        run.stageIndex !== ticket.stageIndex
      )
        throw new ApiError(409, '迟到工具结果不属于当前技能阶段')
      const stage = stageFor(run),
        call = stage.calls.at(-1)!
      await db.query(
        'UPDATE agent_skill_runs SET claimed_call=NULL,claim_expires_at=NULL WHERE id=$1',
        [run.id],
      )
      if (error) {
        const status = error instanceof ApiError ? error.status : 500
        run.state =
          status === 499 ? 'cancelled' : status === 504 ? 'timed-out' : 'failed'
        stage.state = run.state
        stage.error = error instanceof Error ? error.message : '工具失败'
        call.state = run.state
      } else {
        const output = { ...result }
        delete output.confirmation
        if (ticket.auxiliary) call.output = output
        else stage.output = output
        call.state = 'completed'
        if (output.plan) call.planId = text(object(output.plan).id)
        const artifacts = Array.isArray(output.artifacts)
          ? output.artifacts
          : output.artifact
            ? [output.artifact]
            : []
        call.artifactIds = artifacts
          .map((item) => text(object(item).fileId))
          .filter(Boolean)
        if (ticket.auxiliary) {
          run.state = call.phase === 'prepare' ? 'waiting-user' : 'running'
          stage.state = run.state
        } else {
          stage.checks = await this.checks(run, output, db)
          if (stage.checks.some((check) => !check.passed)) {
            stage.state = 'needs-revision'
            run.state = 'needs-revision'
          } else this.advance(run)
        }
      }
      await this.store(db, owner, run, error ? 'tool-failed' : 'tool-completed')
    })
    await this.notify(owner, binding.sessionId)
  }
}
