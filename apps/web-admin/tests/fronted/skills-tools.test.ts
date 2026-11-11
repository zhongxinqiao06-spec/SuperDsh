import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import SchemaField from '@/views/tools/components/SchemaField.vue'
import { configurationDefaults, resolveSchema } from '@/utils/tools/schema'
import { emptyProgram, newStage, validateProgram } from '@/utils/skills/program'
import { useToolSources } from '@/composables/tools/use-tool-sources'
import type { JsonSchema, McpDiscovery } from '@/types/tools/tools'

const mocks = vi.hoisted(() => ({
  discover: vi.fn<() => Promise<McpDiscovery>>(),
  connect: vi.fn(),
}))
vi.mock('@/api/tools/tools-api', () => ({
  toolsApi: {
    sources: async () => [],
    discover: mocks.discover,
    connect: mocks.connect,
  },
}))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({ generation: 0 }),
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: { generation: 0 },
}))
let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})
beforeEach(() => {
  mocks.connect.mockResolvedValue({})
})

describe('声明式技能与工具管理', () => {
  it('按Schema显示嵌套字段，已配置秘密留空保留且清空是显式操作', async () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        credentials: {
          type: 'object',
          additionalProperties: false,
          properties: {
            token: { type: 'string', title: '密钥', writeOnly: true },
          },
        },
        retries: { type: 'integer', minimum: 0, maximum: 5, default: 2 },
      },
      additionalProperties: false,
    }
    wrapper = mount(SchemaField, {
      props: {
        schema,
        root: schema,
        path: '',
        modelValue: { credentials: {}, retries: 2 },
        configuredSecrets: ['credentials.token'],
      },
      global: { plugins: [createPinia(), ElementPlus] },
    })
    expect(
      wrapper.get('input[type="password"]').attributes('placeholder'),
    ).toContain('已配置')
    expect(wrapper.findAll('textarea')).toHaveLength(0)
    const clear = wrapper
      .findAll('button')
      .find((button) => button.text() === '清除已保存凭据')
    await clear!.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      credentials: { token: '' },
      retries: 2,
    })
  })

  it('预设保留字段类型并排除writeOnly默认秘密，局部引用正确展开', () => {
    const schema: JsonSchema = {
      type: 'object',
      $defs: {
        settings: {
          properties: {
            retry: { type: 'integer', default: 2 },
            token: {
              type: 'string',
              writeOnly: true,
              default: 'must-not-copy',
            },
          },
        },
      },
      allOf: [{ $ref: '#/$defs/settings' }],
    }
    expect(resolveSchema(schema).properties?.retry?.type).toBe('integer')
    expect(configurationDefaults(schema)).toEqual({ retry: 2 })
  })

  it('prepare/execute必须相邻且工具授权不能扩大，阶段ID始终唯一', () => {
    const program = emptyProgram()
    const prepare = {
      ...newStage([]),
      name: '准备',
      instructions: '制定方案',
      operation: 'prepare' as const,
      toolIds: ['configured-tool'],
    }
    const execute = {
      ...newStage([prepare]),
      name: '执行',
      instructions: '执行方案',
      operation: 'execute' as const,
      toolIds: ['unapproved-tool'],
    }
    program.stages = [prepare, execute]
    expect(validateProgram(program)).toContain('前一准备阶段')
    execute.toolIds = ['configured-tool']
    expect(validateProgram(program)).toBeNull()
    program.stages.reverse()
    expect(validateProgram(program)).not.toBeNull()
    expect(newStage([prepare, execute]).id).not.toBe(prepare.id)
  })

  it('MCP发现不自动授权，并且更改端点会拒绝迟到的旧发现结果', async () => {
    let resolve: (value: McpDiscovery) => void = () => undefined
    mocks.discover.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    let vm: ReturnType<typeof useToolSources> | undefined
    wrapper = mount(
      defineComponent({
        setup() {
          vm = useToolSources(() => undefined)
          return () => h('div')
        },
      }),
      { global: { plugins: [createPinia()] } },
    )
    await flushPromises()
    vm!.draft.endpoint = 'https://first.invalid/mcp'
    await flushPromises()
    const operation = vm!.discover()
    vm!.draft.endpoint = 'https://second.invalid/mcp'
    resolve({ tools: [], discoveryDigest: 'fixture-discovery' })
    await operation
    expect(vm!.discovery.value).toBeNull()
    expect(vm!.draft.selectedToolIds).toEqual([])
    await vm!.connect()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(vm!.mutation.error.value).toContain('先发现并选择')
  })
})
