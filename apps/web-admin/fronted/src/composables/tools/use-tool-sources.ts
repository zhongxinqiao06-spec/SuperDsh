import { reactive, ref, watch } from 'vue'
import { toolsApi } from '@/api/tools/tools-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { readPackage } from '@/composables/tools/read-package'
import type {
  ExtensionSource,
  McpDiscovery,
  McpDraft,
} from '@/types/tools/tools'
const blank = (): McpDraft => ({
  id: '',
  name: '',
  endpoint: '',
  token: '',
  version: '',
  discoveryDigest: '',
  selectedToolIds: [],
})

/** 安装与MCP授权只在明确提交后发生；发现摘要变化后必须重新选择工具。 */
export function useToolSources(changed: () => void) {
  const resource = useResource(toolsApi.sources),
    mutation = useMutation(),
    tab = ref('installed'),
    target = ref<ExtensionSource | null>(null),
    confirmation = ref<{
      source: ExtensionSource
      enabled: boolean
      version: string
    } | null>(null),
    discovery = ref<McpDiscovery | null>(null),
    draft = reactive(blank()),
    file = ref<File | null>(null),
    notice = ref('')
  const versions = reactive<Record<string, string>>({})
  watch(resource.data, (values) => {
    for (const source of values ?? [])
      versions[source.id] = source.activeVersion
  })
  watch(
    () => [draft.endpoint, draft.token],
    () => {
      discovery.value = null
      draft.discoveryDigest = ''
      draft.selectedToolIds = []
    },
  )
  function edit(source?: ExtensionSource) {
    target.value = source ?? null
    Object.assign(
      draft,
      blank(),
      source
        ? {
            id: source.id,
            name: source.name,
            endpoint: source.endpoint ?? '',
            revision: source.revision,
            token: undefined,
          }
        : {},
    )
    if (!source) delete draft.revision
    tab.value = source?.kind === 'package' ? 'package' : 'mcp'
    discovery.value = null
    file.value = null
    mutation.error.value = ''
  }
  function selectFile(event: Event) {
    file.value = (event.target as HTMLInputElement).files?.[0] ?? null
  }
  /** 新安装先清空来源/凭据草稿，再切换包入口，避免模板承担多步业务状态修改。 */
  function openPackage() {
    edit()
    tab.value = 'package'
  }
  async function installed() {
    await resource.reload()
    changed()
    notice.value = '操作完成 / Operation completed'
  }
  async function install() {
    if (!file.value) {
      mutation.error.value = '请选择扩展ZIP包 / Choose an extension ZIP'
      return
    }
    if (
      await mutation.run(async () => {
        const content = await readPackage(file.value!, 16 * 1024 * 1024)
        await toolsApi.install(
          content,
          target.value?.revision,
          target.value?.id,
        )
      })
    ) {
      file.value = null
      tab.value = 'installed'
      await installed()
    }
  }
  async function discover() {
    const identity = JSON.stringify([
      draft.endpoint,
      draft.token,
      target.value?.id,
    ])
    let value: McpDiscovery | null = null
    if (
      await mutation.run(async () => {
        value = await toolsApi.discover({
          endpoint: draft.endpoint,
          ...(target.value ? { id: target.value.id } : {}),
          ...(draft.token ? { token: draft.token } : {}),
        })
      })
    ) {
      if (
        identity !==
        JSON.stringify([draft.endpoint, draft.token, target.value?.id])
      )
        return
      discovery.value = value
      draft.discoveryDigest = value!.discoveryDigest
      draft.selectedToolIds = []
    }
  }
  async function connect() {
    if (!draft.discoveryDigest || !draft.selectedToolIds.length) {
      mutation.error.value =
        '请先发现并选择要授权的工具 / Discover and select tools first'
      return
    }
    const body = { ...draft }
    if (!body.token) delete body.token
    if (await mutation.run(() => toolsApi.connect(body))) {
      draft.token = ''
      discovery.value = null
      tab.value = 'installed'
      await installed()
    }
  }
  async function confirm() {
    const value = confirmation.value
    if (
      value &&
      (await mutation.run(() =>
        toolsApi.updateSource(
          value.source.id,
          value.source.revision,
          value.enabled,
          value.version,
        ),
      ))
    ) {
      confirmation.value = null
      await installed()
    }
  }
  async function check(source: ExtensionSource) {
    if (
      await mutation.run(() =>
        toolsApi.checkSource(source.id, source.activeVersion),
      )
    )
      await installed()
  }
  return {
    resource,
    mutation,
    tab,
    target,
    confirmation,
    discovery,
    draft,
    file,
    notice,
    versions,
    edit,
    openPackage,
    selectFile,
    install,
    discover,
    connect,
    confirm,
    check,
  }
}
