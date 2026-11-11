import { computed, reactive, ref, watch } from 'vue'
import { toolsApi } from '@/api/tools/tools-api'
import { loadPreparedAgentResources } from '@/store/modules/agent-resources'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import { configurationDefaults } from '@/utils/tools/schema'
import type {
  ImplementationRef,
  ToolDraft,
  ToolResource,
} from '@/types/tools/tools'
export const implementationKey = (value: ImplementationRef) =>
  `${value.sourceId}@${value.version}:${value.toolId}`
const blank = (): ToolDraft => ({
  name: '',
  description: '',
  enabled: true,
  implementation: { sourceId: '', version: '', toolId: '', digest: '' },
  settings: {},
})

/** 配置与来源分开管理；更换实现时重新载入声明默认值，不隐式迁移秘密。 */
export function useTools() {
  const auth = useAuthStore(),
    page = ref(1),
    pageSize = ref(10),
    search = ref(''),
    query = ref('')
  const resource = useResource((signal) =>
      loadPreparedAgentResources(signal, () =>
        toolsApi.list(page.value, pageSize.value, search.value, signal),
      ),
    ),
    sources = useResource(toolsApi.sources),
    capabilities = useResource(toolsApi.capabilities),
    mutation = useMutation()
  const editing = ref<ToolResource | 'new' | null>(null),
    deleting = ref<ToolResource | null>(null),
    history = ref<ToolResource | null>(null),
    sourcesOpen = ref(false),
    draft = reactive(blank())
  const choices = computed(() =>
    (sources.data.value ?? [])
      .filter((source) => source.enabled && source.status === 'ready')
      .flatMap((source) =>
        source.tools.map((descriptor) => ({
          descriptor,
          label: `${source.name} / ${descriptor.name} · ${source.activeVersion}`,
          implementation: {
            sourceId: source.id,
            version: source.activeVersion,
            toolId: descriptor.id,
            digest:
              source.versions.find(
                (value) => value.version === source.activeVersion,
              )?.digest ?? '',
          },
        })),
      ),
  )
  const selected = computed(() =>
    choices.value.find(
      (value) =>
        implementationKey(value.implementation) ===
        implementationKey(draft.implementation),
    ),
  )
  const descriptor = computed(
    () =>
      selected.value?.descriptor ??
      (editing.value && editing.value !== 'new'
        ? editing.value.descriptor
        : undefined),
  )
  watch([page, pageSize], () => void resource.reload())
  function filter() {
    page.value = 1
    search.value = query.value.trim()
    void resource.reload()
  }
  function edit(value: ToolResource | 'new') {
    editing.value = value
    mutation.error.value = ''
    Object.assign(
      draft,
      value === 'new'
        ? blank()
        : {
            name: value.name,
            description: value.description,
            enabled: value.enabled,
            version: value.version,
            implementation: structuredClone(value.implementation),
            settings: structuredClone(value.settings),
          },
    )
    if (value === 'new') delete draft.version
  }
  function choose(key: string) {
    const value = choices.value.find(
      (item) => implementationKey(item.implementation) === key,
    )
    if (value) {
      draft.implementation = { ...value.implementation }
      draft.settings = configurationDefaults(
        value.descriptor.configurationSchema,
      )
    }
  }
  function preset(id: string) {
    const value = descriptor.value?.configurationPresets?.find(
      (item) => item.id === id,
    )
    if (value)
      draft.settings = { ...draft.settings, ...structuredClone(value.values) }
  }
  async function save() {
    const id =
      editing.value && editing.value !== 'new' ? editing.value.id : undefined
    if (
      !draft.name.trim() ||
      !draft.description.trim() ||
      !draft.implementation.sourceId
    ) {
      mutation.error.value = '请选择工具实现，并填写名称和用途说明'
      return
    }
    if (
      await mutation.run(() =>
        toolsApi.save({ ...draft, name: draft.name.trim() }, id),
      )
    ) {
      editing.value = null
      await resource.reload()
    }
  }
  async function remove() {
    if (
      deleting.value &&
      (await mutation.run(() => toolsApi.delete(deleting.value!.id)))
    ) {
      deleting.value = null
      await resource.reload()
    }
  }
  async function refreshed() {
    await Promise.all([sources.reload(), resource.reload()])
  }
  return {
    auth,
    resource,
    sources,
    capabilities,
    mutation,
    page,
    pageSize,
    search,
    query,
    editing,
    deleting,
    history,
    sourcesOpen,
    draft,
    choices,
    selected,
    descriptor,
    filter,
    edit,
    choose,
    preset,
    save,
    remove,
    refreshed,
  }
}
