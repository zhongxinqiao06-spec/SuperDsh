import { ApiError, text, type ApiRouter } from '../http/api-router.ts'
import { json, type Row } from '../infrastructure/database.ts'
import { OfficePlanService } from './office-plans.ts'
import { verifyKnowledgeQuote } from './knowledge-index.ts'
import { verifyKnowledgeTimelineAnswer } from './knowledge-answer-verification.ts'
import { previewOfficeArtifact } from './artifact-preview-cache.ts'
import { BusinessAgentService } from './service.ts'
import { initializeAgentExamples } from './demo.ts'
import { AgentResourceService } from './resources.ts'
import type { AgentBinding } from './contracts.ts'
import { SkillRuntime } from '../skills/runtime.ts'

export function registerBusinessAgentRoutes(
  router: ApiRouter,
  service: BusinessAgentService,
) {
  const plans = new OfficePlanService(service)
  router.add(
    'GET',
    '/sessions/{session_id}/skill-runs',
    (ctx) =>
      new SkillRuntime(service).list(ctx.account!, ctx.params.session_id!),
    { permission: 'files.read' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/skill-runs/{run_id}',
    (ctx) =>
      new SkillRuntime(service).read(
        ctx.account!,
        ctx.params.session_id!,
        ctx.params.run_id!,
      ),
    { permission: 'files.read' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/office-plans',
    (ctx) => plans.list(ctx.account!, ctx.params.session_id!),
    { permission: 'files.read' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/office-plans/{plan_id}',
    async (ctx) => ({
      plan: await plans.read(
        ctx.account!,
        ctx.params.session_id!,
        ctx.params.plan_id!,
      ),
    }),
    { permission: 'files.read' },
  )
  router.add(
    'PUT',
    '/sessions/{session_id}/office-plans/{plan_id}',
    (ctx) =>
      plans.revise(
        ctx.account!,
        ctx.params.session_id!,
        ctx.params.plan_id!,
        ctx.body,
        ctx.signal,
      ),
    { permission: 'files.write' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/agent-artifacts/{artifact_id}/preview',
    async (ctx) => {
      const sessionId = ctx.params.session_id!
      return previewOfficeArtifact(
        service,
        ctx.account!.userId,
        sessionId,
        ctx.params.artifact_id!,
        ctx.signal,
        () => plans.authorize(ctx.account!.userId, sessionId, 'files.read'),
      )
    },
    { permission: 'files.read' },
  )
  const evidence = async (
    owner: string,
    sessionId: string,
    id?: string,
    quote?: string,
  ) => {
    const binding = await plans.authorize(owner, sessionId, 'files.read')
    const saved = await service.options.db.query(
      'SELECT source_json FROM business_agent_evidence WHERE owner_user_id=$1 AND session_id=$2 AND ($3::text IS NULL OR id=$3) ORDER BY created_at DESC LIMIT 100',
      [owner, sessionId, id || null],
    )
    if (id && !saved.length) throw new ApiError(404, '引用不属于当前会话')
    const versions = [
      ...new Set(
        saved.map((row) =>
          Number(json<Row>(row.source_json, {}).bindingVersion ?? 1),
        ),
      ),
    ]
    const history = await service.options.db.query(
      'SELECT version,binding_json FROM agent_session_bindings WHERE session_id=$1 AND owner_user_id=$2 AND version=ANY($3::integer[])',
      [sessionId, owner, versions],
    )
    const snapshots = new Map(
      history.map((row) => [
        Number(row.version),
        json<AgentBinding>(row.binding_json, {} as AgentBinding),
      ]),
    )
    snapshots.set(binding.bindingVersion ?? 1, binding)
    const assets = new Map<number, Row[]>()
    for (const version of versions) {
      const snapshot = snapshots.get(version)
      if (!snapshot?.definition) continue
      const resourceOwner = snapshot.resourceOwnerId || owner
      try {
        await new AgentResourceService(service.options).assertActive(
          resourceOwner,
          snapshot.definition.knowledgeBaseIds ?? [],
          snapshot.definition.skillIds ?? [],
          [],
        )
        assets.set(
          version,
          await service.options.db.query(
            'SELECT id,name,sha256,extracted_text,source_segments_json FROM business_agent_assets WHERE id=ANY($1::text[]) AND owner_user_id=$2',
            [snapshot.definition.knowledgeAssetIds, resourceOwner],
          ),
        )
      } catch (cause) {
        if (!(cause instanceof ApiError) || ![403, 404].includes(cause.status))
          throw cause
      }
    }
    return saved.flatMap((row) => {
      const item = json<Row>(row.source_json, {})
      try {
        const verified = verifyKnowledgeQuote(
          assets.get(Number(item.bindingVersion ?? 1)) ?? [],
          text(item.sourceId),
          quote ?? text(item.content),
        )
        return [{ ...verified, id: text(item.id) }]
      } catch (cause) {
        // Deleted/revoked excerpts must not remain trusted evidence. A direct
        // request still fails, while the list allows other valid sources to open.
        if (
          id ||
          !(cause instanceof ApiError) ||
          ![404, 422].includes(cause.status)
        )
          throw cause
        return []
      }
    })
  }
  router.add(
    'GET',
    '/sessions/{session_id}/agent-evidence',
    async (ctx) => {
      const items = await evidence(ctx.account!.userId, ctx.params.session_id!)
      const [answer] = await service.options.db.query(
        "SELECT id,status,payload_json FROM timeline_items WHERE session_id=$1 AND role='assistant' AND type='message' ORDER BY order_seq DESC LIMIT 1",
        [ctx.params.session_id!],
      )
      return {
        items,
        answerVerification: verifyKnowledgeTimelineAnswer(answer, items),
      }
    },
    { permission: 'files.read' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/agent-evidence/{evidence_id}',
    async (ctx) => ({
      source: (
        await evidence(
          ctx.account!.userId,
          ctx.params.session_id!,
          ctx.params.evidence_id!,
          ctx.url.searchParams.get('quote') ?? undefined,
        )
      )[0],
    }),
    { permission: 'files.read' },
  )
  router.add(
    'GET',
    '/agents',
    (ctx) => service.list(ctx.account!, ctx.url.searchParams),
    { permission: 'sessions.run' },
  )
  router.add(
    'GET',
    '/admin/agents',
    (ctx) => service.list(ctx.account!, ctx.url.searchParams, true),
    { permission: 'agents.manage' },
  )
  router.add(
    'GET',
    '/admin/agents/catalog',
    (ctx) => service.catalog(ctx.account!),
    { permission: 'agents.manage' },
  )
  router.add(
    'GET',
    '/admin/agents/{agent_id}/readiness',
    (ctx) => service.readiness(ctx.account!, ctx.params.agent_id!),
    { permission: 'agents.manage' },
  )
  router.add(
    'POST',
    '/admin/agents',
    async (ctx) => ({ agent: await service.save(ctx.account!, ctx.body) }),
    { permission: 'agents.manage', status: 201 },
  )
  router.add(
    'PUT',
    '/admin/agents/{agent_id}',
    async (ctx) => ({
      agent: await service.save(ctx.account!, ctx.body, ctx.params.agent_id!),
    }),
    { permission: 'agents.manage' },
  )
  router.add(
    'DELETE',
    '/admin/agents/{agent_id}',
    (ctx) => service.remove(ctx.account!, ctx.params.agent_id!),
    { permission: 'agents.manage' },
  )
  router.add(
    'POST',
    '/admin/agents/assets',
    async (ctx) => ({
      asset: await service.upload(ctx.account!, ctx.body, ctx.signal),
    }),
    { permission: 'agents.manage', status: 201 },
  )
  router.add(
    'GET',
    '/admin/agents/assets/{asset_id}/preview',
    (ctx) =>
      service.previewAsset(ctx.account!, ctx.params.asset_id!, ctx.signal),
    { permission: 'agents.manage' },
  )
  router.add(
    'GET',
    '/admin/agents/assets/{asset_id}/download',
    (ctx) => service.asset(ctx.account!, ctx.params.asset_id!),
    { permission: 'agents.manage' },
  )
  router.add(
    'POST',
    '/admin/agents/demo',
    (ctx) =>
      initializeAgentExamples(service, ctx.account!, {
        copyLatest: ctx.body?.copyLatest === true,
      }),
    { permission: 'agents.manage' },
  )
  router.add(
    'POST',
    '/admin/agents/initialize',
    (ctx) => initializeAgentExamples(service, ctx.account!),
    { permission: 'agents.manage' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/agent-artifacts',
    (ctx) => service.artifacts(ctx.account!, ctx.params.session_id!),
    { permission: 'files.read' },
  )
}
