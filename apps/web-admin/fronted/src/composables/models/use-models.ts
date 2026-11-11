import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { modelsApi } from '@/api/models/models-api'
import { accessApi } from '@/api/access/access-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import {
  providerModelError,
  providerPresetDraft,
  type ProviderPreset,
} from '@/utils/models/provider-presets'
import {
  configurationDraft,
  configurationDraftError,
  connectionDraft,
  connectionDraftError,
  providerDraft,
} from '@/utils/models/model-drafts'
import type {
  ConfigurationDraft,
  ConnectionDraft,
  ProviderDraft,
  ModelConfiguration,
  ModelConnection,
  ModelProvider,
  ModelSelection,
  ModelVerification,
} from '@/types/models/models'

/** 平台能力与个人供应商交互用例；失败保留草稿，旧请求由统一身份代际拒绝。 */
export function useModels() {
  const route = useRoute(),
    auth = useAuthStore()
  let mounted = true
  onScopeDispose(() => {
    mounted = false
  })
  const personal = computed(() => route.meta.moduleId === 'account.models')
  const multimodal = computed(() => route.meta.moduleId === 'models.multimodal')
  const allowed = computed(() =>
    auth.can(personal.value ? 'models.personal.manage' : 'models.manage'),
  )
  const catalog = useResource((signal) =>
    allowed.value && !personal.value
      ? modelsApi.catalog(signal)
      : Promise.resolve(null),
  )
  const providers = useResource((signal) =>
    allowed.value && personal.value
      ? modelsApi.providers(true, signal)
      : Promise.resolve({ providers: [] }),
  )
  const selected = useResource((signal) =>
    allowed.value && personal.value
      ? modelsApi.selection(true, signal)
      : Promise.resolve({ selection: null }),
  )
  const roles = useResource((signal) =>
    auth.can('roles.manage') && !personal.value
      ? accessApi.roles(signal)
      : Promise.resolve({ roles: [], permissions: [] }),
  )
  const mutation = useMutation(),
    query = ref(''),
    page = ref(1),
    pageSize = ref(10)
  // 个人供应商与平台能力配置独立分页，切换作用域不能携带另一列表的检索条件。
  const providerQuery = ref(''),
    providerPage = ref(1),
    providerPageSize = ref(10),
    clearPersonalDefault = ref(false)
  const filteredProviders = computed(() => {
    const search = providerQuery.value.trim().toLocaleLowerCase()
    return (providers.data.value?.providers ?? []).filter((item) =>
      `${item.name} ${item.baseUrl} ${item.models.map((model) => `${model.name} ${model.modelId}`).join(' ')}`
        .toLocaleLowerCase()
        .includes(search),
    )
  })
  const providerRows = computed(() =>
    filteredProviders.value.slice(
      (providerPage.value - 1) * providerPageSize.value,
      providerPage.value * providerPageSize.value,
    ),
  )
  const personalDefaultLabel = computed(() => {
    const value = selected.data.value?.selection
    if (!value) return '未设置'
    return (
      providers.data.value?.providers
        .find((item) => item.providerId === value.providerId)
        ?.models.find((item) => item.modelId === value.modelId)?.name ||
      value.modelId
    )
  })
  watch([providerQuery, providerPageSize], () => {
    providerPage.value = 1
  })
  watch(
    () => filteredProviders.value.length,
    (count) => {
      providerPage.value = Math.min(
        providerPage.value,
        Math.max(1, Math.ceil(count / providerPageSize.value)),
      )
    },
  )
  const verificationNotice = ref<{
    type: 'success' | 'warning'
    message: string
  } | null>(null)
  const editingProvider = ref<ModelProvider | 'new' | null>(null),
    editingConnection = ref<ModelConnection | 'new' | null>(null),
    editingConfiguration = ref<ModelConfiguration | 'new' | null>(null)
  const providerPreset = ref<ProviderPreset>('deepseek'),
    makePersonalDefault = ref(false),
    providerModelPage = ref(1),
    providerModelPageSize = ref(10)
  const provider = reactive(providerDraft()),
    connection = reactive(connectionDraft()),
    configuration = reactive(configurationDraft())
  const deleting = ref<ModelProvider | null>(null)
  const configurations = computed(() =>
    (catalog.data.value?.configurations ?? []).filter(
      (item) =>
        (multimodal.value
          ? item.kind === 'multimodal'
          : item.kind === 'chat') &&
        (item.name + item.modelId)
          .toLowerCase()
          .includes(query.value.toLowerCase()),
    ),
  )
  const configurationRows = computed(() =>
    configurations.value.slice(
      (page.value - 1) * pageSize.value,
      page.value * pageSize.value,
    ),
  )
  // 连接由两类模型共享；能力列表为空不代表连接或密钥尚未配置。
  const configurationEmptyMessage = computed(() => {
    if (
      !allowed.value ||
      catalog.loading.value ||
      catalog.error.value ||
      !catalog.data.value ||
      configurations.value.length
    )
      return ''
    if (query.value) return '没有匹配的模型配置，请调整搜索条件。'
    const count = catalog.data.value.connections.length
    if (!count)
      return '尚无供应商连接。请先在“供应商连接”中添加连接，再新增模型配置。'
    const kind = multimodal.value ? '多模态能力' : '聊天模型'
    return `尚无${kind}配置。已配置 ${count} 个供应商连接，请点击“新增配置”选择连接并填写能力与模型 ID。`
  })
  watch([query, multimodal, pageSize], () => {
    page.value = 1
  })
  watch(
    () => configurations.value.length,
    (count) => {
      page.value = Math.min(
        page.value,
        Math.max(1, Math.ceil(count / pageSize.value)),
      )
    },
  )
  /** 接收编辑器的新草稿，状态写入只发生在所属用例。 */
  function updateProvider(value: ProviderDraft): void {
    Object.assign(provider, value)
  }
  /** 接收编辑器的新草稿，状态写入只发生在所属用例。 */
  function updateConnection(value: ConnectionDraft): void {
    Object.assign(connection, value)
  }
  /** 接收编辑器的新草稿，状态写入只发生在所属用例。 */
  function updateConfiguration(value: ConfigurationDraft): void {
    Object.assign(configuration, value)
  }
  async function reload(): Promise<void> {
    await Promise.all([catalog.reload(), providers.reload(), selected.reload()])
  }
  watch([personal, multimodal], () => {
    editingProvider.value = null
    editingConnection.value = null
    editingConfiguration.value = null
    verificationNotice.value = null
    clearPersonalDefault.value = false
    void reload()
    void roles.reload()
  })
  watch(
    () => auth.generation,
    () => {
      editingProvider.value = null
      editingConnection.value = null
      editingConfiguration.value = null
      deleting.value = null
      verificationNotice.value = null
      clearPersonalDefault.value = false
      providerQuery.value = ''
      providerPage.value = 1
      makePersonalDefault.value = false
      Object.assign(provider, providerDraft())
      Object.assign(connection, connectionDraft())
      Object.assign(configuration, configurationDraft())
    },
  )
  function editProvider(value: ModelProvider | 'new'): void {
    editingProvider.value = value
    providerPreset.value = 'deepseek'
    providerModelPage.value = 1
    makePersonalDefault.value =
      value === 'new' && !selected.data.value?.selection
    Object.assign(
      provider,
      value === 'new'
        ? providerPresetDraft(providerPreset.value)
        : providerDraft(value),
    )
    mutation.error.value = ''
  }
  /** 模板切换清空尚未保存的密钥，模板不从用户配置读取真实凭据。 */
  function changeProviderPreset(value: ProviderPreset): void {
    if (editingProvider.value !== 'new') return
    providerPreset.value = value
    providerModelPage.value = 1
    Object.assign(provider, providerPresetDraft(value))
    mutation.error.value = ''
  }
  /** 取消销毁供应商草稿，避免下一次弹窗显示残留密钥。 */
  function closeProvider(): void {
    if (mutation.busy.value) return
    editingProvider.value = null
    makePersonalDefault.value = false
    Object.assign(provider, providerDraft())
    mutation.error.value = ''
  }
  function editConnection(value: ModelConnection | 'new'): void {
    editingConnection.value = value
    Object.keys(connection).forEach((key) => {
      if (key === 'revision') delete connection.revision
    })
    Object.assign(
      connection,
      connectionDraft(value === 'new' ? undefined : value),
    )
    mutation.error.value = ''
  }
  function editConfiguration(value: ModelConfiguration | 'new'): void {
    editingConfiguration.value = value
    delete configuration.revision
    Object.assign(
      configuration,
      configurationDraft(value === 'new' ? undefined : value, multimodal.value),
    )
    mutation.error.value = ''
  }
  async function saveProvider(): Promise<void> {
    const value = editingProvider.value
    if (!value || mutation.busy.value) return
    const invalid = providerModelError(provider)
    if (invalid) {
      providerModelPage.value =
        Math.floor(invalid.index / providerModelPageSize.value) + 1
      mutation.error.value = `第 ${invalid.index + 1} 个模型：${invalid.message}`
      return
    }
    if (
      value === 'new' &&
      providerPreset.value === 'deepseek' &&
      !provider.apiKey.trim()
    ) {
      mutation.error.value = '请填写 API Key。'
      return
    }
    const generation = auth.generation,
      scope = route.meta.moduleId
    const active = () =>
      mounted && auth.generation === generation && route.meta.moduleId === scope
    if (
      (await mutation.run(async () => {
        const saved = await modelsApi.saveProvider(
          personal.value,
          {
            ...provider,
            name: provider.name.trim(),
            baseUrl: provider.baseUrl.trim(),
            apiKey: provider.clearApiKey ? '' : provider.apiKey.trim(),
            models: provider.models.map((item) => ({
              ...item,
              modelId: item.modelId.trim(),
              name: item.name.trim() || item.modelId.trim(),
              inputTypes: [...item.inputTypes],
            })),
          },
          value === 'new' ? undefined : value.providerId,
        )
        if (!active()) return
        // 创建与设置默认是两个写请求；前者成功后转为编辑，默认失败重试不得重复创建供应商。
        editingProvider.value = saved
        provider.apiKey = ''
        provider.clearApiKey = false
        if (makePersonalDefault.value && saved.enabled) {
          const model = saved.models[0]
          if (!model) throw new Error('供应商未返回可用模型。')
          await modelsApi.setSelection(personal.value, {
            providerId: saved.providerId,
            modelId: model.modelId,
          })
        }
      })) &&
      active()
    ) {
      editingProvider.value = null
      makePersonalDefault.value = false
      Object.assign(provider, providerDraft())
      await reload()
    }
  }
  async function saveConnection(): Promise<void> {
    const value = editingConnection.value
    if (!value || mutation.busy.value) return
    const invalid = connectionDraftError(connection)
    if (invalid) {
      mutation.error.value = invalid
      return
    }
    const scope = route.meta.moduleId
    if (
      (await mutation.run(() =>
        modelsApi.saveConnection(
          {
            ...connection,
            name: connection.name.trim(),
            baseUrl: connection.baseUrl.trim(),
            region: connection.region.trim(),
            apiKey: connection.clearApiKey ? '' : connection.apiKey.trim(),
          },
          value === 'new' ? undefined : value.id,
        ),
      )) &&
      route.meta.moduleId === scope
    ) {
      editingConnection.value = null
      connection.apiKey = ''
      await reload()
    }
  }
  async function saveConfiguration(): Promise<void> {
    const value = editingConfiguration.value
    if (!value || mutation.busy.value) return
    const invalid = configurationDraftError(configuration)
    if (invalid) {
      mutation.error.value = invalid
      return
    }
    const scope = route.meta.moduleId
    if (
      (await mutation.run(() =>
        modelsApi.saveConfiguration(
          {
            ...configuration,
            name: configuration.name.trim(),
            connectionId: configuration.connectionId.trim(),
            modelId: configuration.modelId.trim(),
            parameters: { ...configuration.parameters },
            roleIds: [...configuration.roleIds],
          },
          value === 'new' ? undefined : value.id,
        ),
      )) &&
      route.meta.moduleId === scope
    ) {
      editingConfiguration.value = null
      await reload()
    }
  }
  async function verify(id: string): Promise<void> {
    if (mutation.busy.value) return
    verificationNotice.value = null
    const scope = route.meta.moduleId
    const result: { value: ModelVerification | null } = { value: null }
    if (
      (await mutation.run(async () => {
        result.value = await (personal.value
          ? modelsApi.verifyProvider(true, id)
          : modelsApi.verifyConfiguration(id))
      })) &&
      result.value &&
      scope === route.meta.moduleId
    ) {
      // 请求成功不等于检测通过；账号和页面仍有效时才展示供应商只读检测结论。
      verificationNotice.value = {
        type:
          result.value.ok === true && result.value.status === 'verified'
            ? 'success'
            : 'warning',
        message: result.value.message,
      }
    }
  }
  async function deleteProvider(): Promise<void> {
    const value = deleting.value
    if (
      value &&
      (await mutation.run(() =>
        modelsApi.deleteProvider(personal.value, value.providerId),
      ))
    ) {
      deleting.value = null
      await reload()
    }
  }
  async function selectModel(selection: ModelSelection | null): Promise<void> {
    if (await mutation.run(() => modelsApi.setSelection(true, selection))) {
      clearPersonalDefault.value = false
      await selected.reload()
    }
  }
  async function setDefault(
    value: ModelConfiguration,
    clear = false,
  ): Promise<void> {
    const prior = catalog.data.value?.defaults.find(
      (item) => item.capability === value.capability,
    )
    if (
      await mutation.run(() =>
        modelsApi.setDefault(
          value.capability,
          clear ? null : value.id,
          prior?.revision ?? 0,
        ),
      )
    )
      await reload()
  }
  return {
    providerPreset,
    changeProviderPreset,
    closeProvider,
    makePersonalDefault,
    providerModelPage,
    providerModelPageSize,
    providerQuery,
    providerPage,
    providerPageSize,
    filteredProviders,
    providerRows,
    personalDefaultLabel,
    clearPersonalDefault,
    page,
    pageSize,
    configurationRows,
    configurationEmptyMessage,
    updateConfiguration,
    updateConnection,
    updateProvider,
    personal,
    multimodal,
    allowed,
    auth,
    catalog,
    providers,
    selected,
    roles,
    mutation,
    verificationNotice,
    query,
    configurations,
    editingProvider,
    editingConnection,
    editingConfiguration,
    provider,
    connection,
    configuration,
    deleting,
    reload,
    editProvider,
    editConnection,
    editConfiguration,
    saveProvider,
    saveConnection,
    saveConfiguration,
    verify,
    deleteProvider,
    selectModel,
    setDefault,
  }
}
