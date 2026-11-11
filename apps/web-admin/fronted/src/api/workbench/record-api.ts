import { request } from '@/utils/request'
/** 方案和引用均由持久收据产生，不包含工具确认凭证。 */
export interface PlanRecord {
  id: string
  version: number
  title: string
  state: string
  summary: string
  document: Record<string, unknown>
}
export interface SourceRecord {
  id: string
  sourceId: string
  filename: string
  content: string
  sha256: string
  location: Record<string, unknown>
}
export interface AnswerVerification {
  status: string
  message: string
  issues: string[]
}
const path = (session: string) => `/sessions/${encodeURIComponent(session)}`
export const recordApi = {
  plans: (session: string, signal?: AbortSignal) =>
    request<{ items: PlanRecord[] }>(`${path(session)}/plans`, { signal }),
  revise: (
    session: string,
    plan: PlanRecord,
    document: Record<string, unknown>,
  ) =>
    request<{ plan: PlanRecord; note: string }>(
      `${path(session)}/plans/${encodeURIComponent(plan.id)}`,
      {
        method: 'PUT',
        body: { version: plan.version, document },
        timeoutMs: 180000,
      },
    ),
  evidence: (session: string, signal?: AbortSignal) =>
    request<{ items: SourceRecord[]; answerVerification: AnswerVerification }>(
      `${path(session)}/evidence`,
      { signal },
    ),
  source: (session: string, id: string, signal?: AbortSignal) =>
    request<{ source: SourceRecord }>(
      `${path(session)}/evidence/${encodeURIComponent(id)}`,
      { signal },
    ),
}
