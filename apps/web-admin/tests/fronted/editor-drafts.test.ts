import { afterEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, {
  ElCheckboxGroup,
  ElInput,
  ElInputNumber,
  ElSelect,
} from 'element-plus'
import AgentEditor from '@/views/agents/components/AgentEditor.vue'
import EmbeddingEditor from '@/views/knowledge/components/EmbeddingEditor.vue'
import ConfigurationEditor from '@/views/models/components/ConfigurationEditor.vue'
import ModelConnectionEditor from '@/views/models/components/ConnectionEditor.vue'
import ProviderEditor from '@/views/models/components/ProviderEditor.vue'
import StorageConnectionEditor from '@/views/storage/components/ConnectionEditor.vue'
import { agentDraft } from '@/utils/agents/agent-drafts'
import { embeddingDraft } from '@/utils/knowledge/knowledge-drafts'
import {
  configurationDraft,
  connectionDraft,
  providerDraft,
} from '@/utils/models/model-drafts'
import { connectionDraft as storageDraft } from '@/utils/storage/storage-drafts'

/** 冻结输入可发现嵌套 props 写入；编辑器仅以事件申请父级状态更新。 */
function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') freeze(child)
  }
  Object.freeze(value)
  return value
}

let wrapper: VueWrapper | undefined
const global = { plugins: [ElementPlus] }
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('编辑器草稿单向更新', () => {
  it('智能体固定技能变更发出新策略，原策略保持不变', () => {
    const draft = freeze({
      ...agentDraft(),
      skillPolicy: { mode: 'fixed' as const, fixedSkillId: 'before' },
    })
    wrapper = shallowMount(AgentEditor, {
      props: { draft, catalog: null },
      global: { ...global, renderStubDefaultSlot: true },
    })
    wrapper
      .findAllComponents(ElSelect)
      .at(-1)!
      .vm.$emit('update:modelValue', 'after')
    expect(draft.skillPolicy.fixedSkillId).toBe('before')
    expect(wrapper.emitted('update:draft')).toEqual([
      [{ ...draft, skillPolicy: { mode: 'fixed', fixedSkillId: 'after' } }],
    ])
  })

  it('Embedding 维度清空不会写入 undefined 或修改原草稿', () => {
    const draft = freeze({
      ...embeddingDraft(),
      kind: 'openai-compatible' as const,
      dimensions: 32,
    })
    wrapper = shallowMount(EmbeddingEditor, {
      props: { draft, settings: null, busy: false },
      global,
    })
    wrapper.getComponent(ElInputNumber).vm.$emit('update:modelValue', undefined)
    expect(wrapper.emitted('update:draft')?.[0]).toEqual([
      { ...draft, dimensions: 32 },
    ])
    expect(draft.dimensions).toBe(32)
  })

  it('能力切换原子清除新草稿参数，保留原参数对象', () => {
    const draft = freeze({
      ...configurationDraft(),
      parameters: { maxTokens: 128 },
    })
    wrapper = shallowMount(ConfigurationEditor, {
      props: {
        draft,
        catalog: null,
        editing: false,
        multimodal: true,
        roles: [],
      },
      global,
    })
    wrapper
      .findAllComponents(ElSelect)[1]!
      .vm.$emit('update:modelValue', 'image.generate')
    expect(draft.parameters).toEqual({ maxTokens: 128 })
    expect(wrapper.emitted('update:draft')).toEqual([
      [{ ...draft, capability: 'image.generate', parameters: {} }],
    ])
  })

  it('供应商模型行编辑创建新数组和新行，原模型不可变', () => {
    const draft = freeze(providerDraft())
    wrapper = shallowMount(ProviderEditor, {
      props: { draft, keyConfigured: true },
      global,
    })
    wrapper
      .find('fieldset')
      .findAllComponents(ElInput)[0]!
      .vm.$emit('update:modelValue', 'new-model')
    expect(draft.models[0]!.modelId).toBe('')
    const next = wrapper.emitted('update:draft')?.[0]?.[0]
    expect(next).toEqual({
      ...draft,
      models: [{ ...draft.models[0], modelId: 'new-model' }],
    })
    expect(next).not.toBe(draft)
    wrapper
      .getComponent(ElCheckboxGroup)
      .vm.$emit('update:modelValue', ['text', 'image', 'unsupported'])
    expect(draft.models[0]!.inputTypes).toEqual(['text'])
    expect(wrapper.emitted('update:draft')?.[1]?.[0]).toEqual({
      ...draft,
      models: [{ ...draft.models[0], inputTypes: ['text', 'image'] }],
    })
  })

  it('模型连接名称通过事件更新且不污染原连接', () => {
    const draft = freeze(connectionDraft())
    wrapper = shallowMount(ModelConnectionEditor, {
      props: { draft, keyConfigured: false },
      global,
    })
    wrapper
      .findAllComponents(ElInput)[0]!
      .vm.$emit('update:modelValue', '新连接')
    expect(draft.name).toBe('')
    expect(wrapper.emitted('update:draft')).toEqual([
      [{ ...draft, name: '新连接' }],
    ])
  })

  it('存储连接名称通过事件更新且不污染原连接', () => {
    const draft = freeze(storageDraft())
    wrapper = shallowMount(StorageConnectionEditor, {
      props: { draft, existing: false },
      global,
    })
    wrapper
      .findAllComponents(ElInput)[0]!
      .vm.$emit('update:modelValue', '新存储')
    expect(draft.name).toBe('')
    expect(wrapper.emitted('update:draft')).toEqual([
      [{ ...draft, name: '新存储' }],
    ])
  })
})
