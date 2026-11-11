import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useModels } from '@/composables/models/use-models'
import { useAgents } from '@/composables/agents/use-agents'
import { providerDraft, configurationDraft } from '@/utils/models/model-drafts'
import { agentDraft } from '@/utils/agents/agent-drafts'
import {
  embeddingDraft,
  sourceLocation,
} from '@/utils/knowledge/knowledge-drafts'
import type {
  ModelCatalog,
  ModelProvider,
  ModelVerification,
} from '@/types/models/models'
import type { AgentDefinition } from '@/types/agents/agents'

const mocks = vi.hoisted(() => ({
  generation: 0,
  route: { meta: { moduleId: 'account.models' } },
  saveProvider: vi.fn(),
  saveConnection: vi.fn(),
  saveConfiguration: vi.fn(),
  setSelection: vi.fn(),
  providers: vi.fn(),
  selection: vi.fn(),
  catalog: vi.fn(),
  verifyProvider: vi.fn(),
  verifyConfiguration: vi.fn(),
  agentList: vi.fn(),
  agentCatalog: vi.fn(),
  saveAgent: vi.fn(),
  stage: vi.fn(),
  push: vi.fn(),
}))
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: {
    get generation() {
      return mocks.generation
    },
  },
}))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({
    get generation() {
      return mocks.generation
    },
    can: () => true,
  }),
}))
vi.mock('@/api/access/access-api', () => ({
  accessApi: { roles: async () => ({ roles: [], permissions: [] }) },
}))
vi.mock('@/api/models/models-api', () => ({
  modelsApi: {
    providers: mocks.providers,
    selection: mocks.selection,
    catalog: mocks.catalog,
    saveProvider: mocks.saveProvider,
    saveConnection: mocks.saveConnection,
    saveConfiguration: mocks.saveConfiguration,
    setSelection: mocks.setSelection,
    verifyProvider: mocks.verifyProvider,
    verifyConfiguration: mocks.verifyConfiguration,
  },
}))
vi.mock('@/api/agents/agents-api', () => ({
  agentsApi: {
    list: mocks.agentList,
    catalog: mocks.agentCatalog,
    save: mocks.saveAgent,
  },
}))
vi.mock('@/api/workbench/trial', () => ({ stageAgentTrial: mocks.stage }))

const provider: ModelProvider = {
  providerId: 'synthetic-provider',
  name: '合成供应商',
  protocol: 'openai-completions',
  baseUrl: 'https://synthetic.invalid',
  enabled: true,
  apiKeyConfigured: true,
  source: 'personal',
  createdAt: '',
  updatedAt: '',
  models: [
    {
      modelId: 'synthetic-model',
      name: '合成模型',
      contextWindow: 32000,
      maxTokens: 1024,
      inputTypes: ['text', 'image'],
    },
  ],
}
const agent: AgentDefinition = {
  id: 'synthetic-agent',
  version: 3,
  name: '合成助手',
  description: '',
  instructions: '使用绑定资料',
  recommendedPrompts: ['我想查看报销流程'],
  inputRequirements: [],
  outputExamples: [],
  knowledgeBaseIds: [],
  knowledgeAssetIds: [],
  templateAssetIds: [],
  skillIds: [],
  toolIds: [],
  published: true,
  createdAt: '',
  updatedAt: '',
}
let wrapper: VueWrapper | undefined

beforeEach(() => {
  mocks.generation = 0
  mocks.verifyProvider.mockReset()
  mocks.verifyConfiguration.mockReset()
  mocks.saveProvider.mockReset()
  mocks.saveConnection.mockReset().mockResolvedValue({})
  mocks.saveConfiguration.mockReset().mockResolvedValue({})
  mocks.setSelection.mockReset().mockResolvedValue({})
  mocks.route.meta.moduleId = 'account.models'
  mocks.providers.mockResolvedValue({ providers: [provider] })
  mocks.selection.mockResolvedValue({ selection: null })
  mocks.catalog.mockResolvedValue({
    configurations: [],
    connections: [],
    defaults: [],
    capabilities: [],
  })
  mocks.agentList.mockResolvedValue({
    items: [agent],
    total: 1,
    page: 1,
    pageSize: 12,
  })
  mocks.agentCatalog.mockResolvedValue({
    assets: [],
    skills: [],
    tools: [],
    knowledgeBases: [],
  })
  mocks.saveAgent.mockResolvedValue({ agent })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('模型只读检测结论', () => {
  const unavailable: ModelVerification = {
    ok: false,
    status: 'unverified',
    message:
      '模型目录请求返回 HTTP 404，无法通过只读检测确认；本次未发起模型生成。',
    serverTime: '',
  }

  function mountModels(): ReturnType<typeof useModels> {
    let vm!: ReturnType<typeof useModels>
    wrapper = mount(
      defineComponent({
        setup() {
          vm = useModels()
          return () => h('div')
        },
      }),
    )
    return vm
  }

  it('已有共享连接但只有聊天配置时，多模态页说明缺少能力配置且保留连接', async () => {
    mocks.route.meta.moduleId = 'models.multimodal'
    const catalog: ModelCatalog = {
      connections: [
        {
          id: 'synthetic-connection',
          name: '合成连接',
          adapter: 'openai-completions',
          baseUrl: 'https://synthetic.invalid',
          region: '',
          enabled: true,
          revision: 1,
          credentialConfigured: true,
          scope: 'platform',
        },
      ],
      configurations: [
        {
          id: 'synthetic-chat',
          name: '合成聊天模型',
          connectionId: 'synthetic-connection',
          capability: 'chat',
          modelId: 'synthetic-model',
          kind: 'chat',
          revision: 1,
          enabled: true,
          parameters: {},
          roleIds: [],
        },
      ],
      defaults: [],
      capabilities: [],
    }
    mocks.catalog.mockResolvedValue(catalog)
    const vm = mountModels()
    expect(vm.configurationEmptyMessage.value).toBe('')
    await flushPromises()
    expect(vm.configurationRows.value).toEqual([])
    expect(vm.catalog.data.value?.connections).toEqual(catalog.connections)
    expect(vm.configurationEmptyMessage.value).toContain('尚无多模态能力配置')
    expect(vm.configurationEmptyMessage.value).toContain(
      '已配置 1 个供应商连接',
    )
    vm.query.value = '未匹配'
    expect(vm.configurationEmptyMessage.value).toContain('搜索条件')
    vm.query.value = ''
    mocks.catalog.mockRejectedValueOnce(new Error('合成加载失败'))
    await vm.catalog.reload()
    expect(vm.configurationEmptyMessage.value).toBe('')
    expect(vm.catalog.error.value).toBe('合成加载失败')
  })

  it('确实没有共享连接时才提示新增连接', async () => {
    mocks.route.meta.moduleId = 'models.chat'
    const vm = mountModels()
    await flushPromises()
    expect(vm.configurationEmptyMessage.value).toContain('尚无供应商连接')
  })

  it('空白模型配置保留草稿，必填齐全后去除边缘空白再提交', async () => {
    mocks.route.meta.moduleId = 'models.multimodal'
    const vm = mountModels()
    await flushPromises()
    vm.editConfiguration('new')
    Object.assign(vm.configuration, {
      name: '  ',
      connectionId: '  ',
      modelId: '  ',
    })
    await vm.saveConfiguration()
    expect(mocks.saveConfiguration).not.toHaveBeenCalled()
    expect(vm.editingConfiguration.value).toBe('new')
    expect(vm.mutation.error.value).toContain('配置名称')
    vm.configuration.name = ' 合成配置 '
    await vm.saveConfiguration()
    expect(vm.mutation.error.value).toContain('供应商连接')
    vm.configuration.connectionId = ' synthetic-connection '
    await vm.saveConfiguration()
    expect(vm.mutation.error.value).toContain('模型 ID')
    vm.configuration.modelId = ' synthetic-model '
    await vm.saveConfiguration()
    expect(mocks.saveConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '合成配置',
        connectionId: 'synthetic-connection',
        modelId: 'synthetic-model',
      }),
      undefined,
    )
    expect(vm.editingConfiguration.value).toBeNull()
  })

  it('连接地址及名称无效时不请求，失败保留有效草稿供重试', async () => {
    mocks.route.meta.moduleId = 'models.chat'
    const vm = mountModels()
    await flushPromises()
    vm.editConnection('new')
    await vm.saveConnection()
    expect(mocks.saveConnection).not.toHaveBeenCalled()
    expect(vm.editingConnection.value).toBe('new')
    Object.assign(vm.connection, {
      name: ' 合成连接 ',
      baseUrl: 'https://name:secret@synthetic.invalid',
    })
    await vm.saveConnection()
    expect(mocks.saveConnection).not.toHaveBeenCalled()
    vm.connection.baseUrl = ' https://synthetic.invalid '
    mocks.saveConnection.mockRejectedValueOnce(new Error('合成失败'))
    await vm.saveConnection()
    expect(vm.editingConnection.value).toBe('new')
    expect(vm.connection.baseUrl).toBe(' https://synthetic.invalid ')
    expect(mocks.saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '合成连接',
        baseUrl: 'https://synthetic.invalid',
      }),
      undefined,
    )
  })

  it('个人供应商按旧界面搜索名称地址和模型，并保持独立分页及默认显示名称', async () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({
      ...provider,
      providerId: `synthetic-provider-${index}`,
      name: `供应商 ${index}`,
      models: [
        {
          ...provider.models[0]!,
          name: `模型 ${index}`,
          modelId: `model-${index}`,
        },
      ],
    }))
    mocks.providers.mockResolvedValue({ providers: entries })
    mocks.selection.mockResolvedValue({
      selection: { providerId: entries[10]!.providerId, modelId: 'model-10' },
    })
    const vm = mountModels()
    await flushPromises()
    expect(vm.providerRows.value).toHaveLength(10)
    expect(vm.personalDefaultLabel.value).toBe('模型 10')
    vm.providerPage.value = 2
    await flushPromises()
    expect(vm.providerRows.value.map((item) => item.providerId)).toEqual([
      'synthetic-provider-10',
    ])
    vm.providerQuery.value = ' MODEL-10 '
    await flushPromises()
    expect(vm.providerPage.value).toBe(1)
    expect(vm.providerRows.value.map((item) => item.name)).toEqual([
      '供应商 10',
    ])
    expect(vm.query.value).toBe('')
    vm.providerQuery.value = 'synthetic.invalid'
    await flushPromises()
    expect(vm.filteredProviders.value).toHaveLength(11)
    vm.providerQuery.value = 'not-present'
    await flushPromises()
    expect(vm.filteredProviders.value).toEqual([])
  })

  it('个人供应商创建模板不含凭据，默认失败保留已创建身份且重试不会再次创建', async () => {
    const vm = mountModels()
    await flushPromises()
    vm.editProvider('new')
    expect(vm.provider.name).toBe('DeepSeek')
    expect(vm.provider.models.map((item) => item.modelId)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
    expect(vm.provider.apiKey).toBe('')
    expect(vm.makePersonalDefault.value).toBe(true)
    vm.provider.apiKey = 'synthetic-key'
    mocks.saveProvider.mockResolvedValue(provider)
    mocks.setSelection.mockRejectedValueOnce(new Error('合成默认写入失败'))
    await vm.saveProvider()
    expect(vm.editingProvider.value).toEqual(provider)
    expect(vm.provider.apiKey).toBe('')
    expect(vm.mutation.error.value).toContain('合成默认写入失败')
    await vm.saveProvider()
    expect(mocks.saveProvider.mock.calls.map((call) => call[2])).toEqual([
      undefined,
      provider.providerId,
    ])
    expect(mocks.setSelection).toHaveBeenLastCalledWith(true, {
      providerId: provider.providerId,
      modelId: provider.models[0]!.modelId,
    })
    expect(vm.editingProvider.value).toBeNull()
  })

  it('个人供应商行校验定位错误页，自定义模板与取消都清除未提交密钥', async () => {
    const vm = mountModels()
    await flushPromises()
    vm.editProvider('new')
    vm.provider.apiKey = 'synthetic-key'
    vm.changeProviderPreset('custom')
    expect(vm.provider.apiKey).toBe('')
    expect(vm.provider.name).toBe('')
    vm.provider.models = Array.from({ length: 11 }, (_, index) => ({
      ...provider.models[0]!,
      modelId: `model-${index}`,
    }))
    vm.provider.models[10]!.modelId = 'model-0'
    await vm.saveProvider()
    expect(vm.providerModelPage.value).toBe(2)
    expect(vm.mutation.error.value).toContain('第 11 个模型')
    expect(mocks.saveProvider).not.toHaveBeenCalled()
    vm.provider.apiKey = 'synthetic-unsaved-key'
    vm.closeProvider()
    expect(vm.provider.apiKey).toBe('')
    expect(vm.editingProvider.value).toBeNull()
  })

  it('创建响应晚于账号切换时不再用新账号凭据写入默认选择', async () => {
    let resolve!: (value: ModelProvider) => void
    mocks.saveProvider.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const vm = mountModels()
    await flushPromises()
    vm.editProvider('new')
    vm.provider.apiKey = 'synthetic-key'
    const saving = vm.saveProvider()
    mocks.generation += 1
    resolve(provider)
    await saving
    expect(mocks.setSelection).not.toHaveBeenCalled()
    expect(mocks.providers).toHaveBeenCalledTimes(1)
  })

  it.each(['account.models', 'models.chat'])(
    '%s 的 HTTP 成功但未确认结果显示警告',
    async (moduleId) => {
      mocks.route.meta.moduleId = moduleId
      mocks.verifyProvider.mockResolvedValueOnce(unavailable)
      mocks.verifyConfiguration.mockResolvedValueOnce(unavailable)
      const vm = mountModels()
      await flushPromises()
      await vm.verify('synthetic-model')
      expect(vm.verificationNotice.value).toStrictEqual({
        type: 'warning',
        message: unavailable.message,
      })
      expect(vm.mutation.error.value).toBe('')
      if (moduleId === 'account.models')
        expect(mocks.verifyProvider).toHaveBeenCalledWith(
          true,
          'synthetic-model',
        )
      else
        expect(mocks.verifyConfiguration).toHaveBeenCalledWith(
          'synthetic-model',
        )
    },
  )

  it('目录通过显示有范围限制的成功文案，后续失败清除旧结论', async () => {
    const verified: ModelVerification = {
      ok: true,
      status: 'verified',
      message: '模型目录可访问；未发起模型生成，具体模型调用能力尚未验证。',
      serverTime: '',
    }
    mocks.verifyProvider.mockResolvedValueOnce(verified)
    const vm = mountModels()
    await flushPromises()
    await vm.verify('synthetic-model')
    expect(vm.verificationNotice.value).toStrictEqual({
      type: 'success',
      message: verified.message,
    })
    mocks.verifyProvider.mockRejectedValueOnce(
      new Error('供应商拒绝模型目录访问'),
    )
    await vm.verify('synthetic-model')
    expect(vm.verificationNotice.value).toBeNull()
    expect(vm.mutation.error.value).toContain('供应商拒绝模型目录访问')
  })

  it.each(['换号', '卸载', '切换页面'])(
    '%s 后不显示晚到检测结论',
    async (change) => {
      let resolve!: (value: ModelVerification) => void
      mocks.verifyProvider.mockImplementationOnce(
        () =>
          new Promise<ModelVerification>((done) => {
            resolve = done
          }),
      )
      const vm = mountModels()
      await flushPromises()
      const request = vm.verify('synthetic-model')
      if (change === '换号') mocks.generation += 1
      else if (change === '卸载') wrapper?.unmount()
      else mocks.route.meta.moduleId = 'models.chat'
      resolve(unavailable)
      await request
      expect(vm.verificationNotice.value).toBeNull()
    },
  )
})

describe('模型、智能体和知识交互边界', () => {
  it('模型草稿不复制密钥，取消编辑不改变原目录', () => {
    const draft = providerDraft(provider)
    draft.models[0]!.name = '新草稿'
    draft.models[0]!.inputTypes.push('text')
    expect(draft.apiKey).toBe('')
    expect(draft.clearApiKey).toBe(false)
    expect(provider.models[0]!.name).toBe('合成模型')
    expect(provider.models[0]!.inputTypes).toEqual(['text', 'image'])
    expect(configurationDraft(undefined, true).capability).toBe(
      'image.generate',
    )
  })

  it('个人模型提交失败保留草稿，成功提交不携带响应元数据', async () => {
    let vm!: ReturnType<typeof useModels>
    wrapper = mount(
      defineComponent({
        setup() {
          vm = useModels()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    vm.editProvider(provider)
    vm.provider.name = '未丢失的草稿'
    mocks.saveProvider.mockRejectedValueOnce(new Error('合成网络失败'))
    await vm.saveProvider()
    expect(vm.editingProvider.value).toStrictEqual(provider)
    expect(vm.provider.name).toBe('未丢失的草稿')
    expect(vm.mutation.error.value).toContain('合成网络失败')
    mocks.saveProvider.mockResolvedValueOnce(provider)
    await vm.saveProvider()
    expect(vm.editingProvider.value).toBeNull()
    const body = mocks.saveProvider.mock.calls[1]![1]
    expect(body).not.toHaveProperty('providerId')
    expect(body).not.toHaveProperty('apiKeyConfigured')
    expect(body.models[0].inputTypes).toEqual(['text', 'image'])
  })

  it('发布失败保留原发布状态，试用只暂存草稿并导航', async () => {
    let vm!: ReturnType<typeof useAgents>
    wrapper = mount(
      defineComponent({
        setup() {
          vm = useAgents()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    mocks.saveAgent.mockRejectedValueOnce(new Error('版本冲突'))
    await vm.publish(agent)
    expect(agent.published).toBe(true)
    expect(vm.mutation.error.value).toContain('版本冲突')
    await vm.trial(agent)
    expect(mocks.stage).toHaveBeenCalledWith(
      'synthetic-agent',
      '我想查看报销流程',
    )
    expect(mocks.push).toHaveBeenCalledWith('/workspace')
    expect(mocks.saveAgent).toHaveBeenCalledTimes(1)
  })

  it('账号代际变化后迟到保存不关闭新账号界面或刷新目录', async () => {
    let resolve!: (value: object) => void
    mocks.saveProvider.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    let vm!: ReturnType<typeof useModels>
    wrapper = mount(
      defineComponent({
        setup() {
          vm = useModels()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    vm.editProvider(provider)
    const saving = vm.saveProvider()
    mocks.generation += 1
    resolve(provider)
    await saving
    expect(mocks.providers).toHaveBeenCalledTimes(1)
  })

  it('Agent字段与知识来源定位不凭空构造，Embedding设置永不回填密钥', () => {
    const value = agentDraft(agent)
    expect(value).not.toHaveProperty('id')
    expect(value.version).toBe(3)
    expect(
      sourceLocation({
        sourceId: 'source',
        assetId: 'asset',
        filename: '表格.xlsx',
        sha256: '',
        content: '金额100',
        paragraph: 0,
        location: { sheet: '销售', row: 2 },
      }),
    ).toBe('工作表 销售 · 第 2 行')
    const profile = {
      id: 'external',
      kind: 'openai-compatible' as const,
      model: 'synthetic',
      revision: 'fixture',
      dimensions: 3,
      apiKeyConfigured: true,
    }
    expect(
      embeddingDraft({ version: 4, profile, localDefault: profile }),
    ).toMatchObject({ version: 4, apiKey: '', clearApiKey: false })
  })
})
