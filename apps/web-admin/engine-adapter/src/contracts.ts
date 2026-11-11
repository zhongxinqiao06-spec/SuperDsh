import type { PresetAgent } from './preset-plugin.ts'

/** 固定引擎公开接缝的最小类型；不携带平台业务、数据库或认证实现。 */
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json }
export type Fields = { [key: string]: Json }
export interface Execution {
  agent?: { id: string; status: string }
  callId: string
  signal: AbortSignal
}
export interface ToolDefinition {
  name: string
  description: string
  parameters: Fields
  output: {
    schema: Fields
    render(
      args: Fields,
      value: { result: string },
    ): { type: 'text'; text: string }[]
  }
  execute(args: Fields, execution: Execution): Promise<{ result: string }>
  presentCall(): { card: string; title: string; kind: string }
}
export interface Host {
  ready: Promise<void>
  shutdown(code: number): Promise<void>
  ctx: {
    agents: { get(id: string): PresetAgent | undefined }
    on(
      event: 'agent/created',
      callback: (value: { agent: PresetAgent }) => void,
    ): () => void
    get(
      name: 'agentsAnywhereRuntime',
    ): { restart(): Promise<{ state: string }> } | undefined
    get(name: 'superdshManagedModels'): { refresh(): Promise<void> } | undefined
    get(
      name: 'permissionPresets',
    ): { readonly defaultPreset: string } | undefined
    get(name: 'agentPresets'):
      | {
          register(definition: {
            id: string
            name: string
            description: string
            plugins: { name: string; config: Fields }[]
          }): Promise<() => Promise<void>>
          list(): Promise<{ id: string; broken?: string }[]>
          composedPreset(ctx: PresetAgent['ctx']): string | undefined
        }
      | undefined
    userQuestions: {
      ask(value: {
        agent: NonNullable<Execution['agent']>
        signal: AbortSignal
        questions: {
          id: string
          question: string
          detail: string
          intent: { kind: string; approve: string; callId: string }
          options: { label: string }[]
        }[]
      }): Promise<{
        answers: { id: string; custom?: string; selected?: string[] }[]
      }>
    }
    tools: { register(definition: ToolDefinition): () => void }
  }
}
export interface ToolDescriptor {
  id: string
  name: string
  revision: number
  description: string
  parameters: Fields
  timeoutSeconds?: number
}

/** 不信任控制输入；边界拒绝标量和数组，不宽泛地视为已验证 DTO。 */
export function fields(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid engine control object')
  return value as Fields
}
