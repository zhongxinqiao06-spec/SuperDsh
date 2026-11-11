import { computed, ref, watch, type Ref } from 'vue'
import { conversationApi } from '@/api/workbench/conversation-api'
import { sessionController } from '@/store/session-controller'
import type { WorkspaceDraft } from '@/store/modules/draft-store'
import type { RuntimeCatalog, SessionSnapshot } from '@/types/workbench/models'
import { canControlSession } from '@/utils/workbench/session-access'
import { errorMessage } from '@/utils/errors'
import {
  catalogItemEnabled,
  catalogLabel,
  modelIdsForSelectionId,
  permissionIdForSelectionId,
  selectionIdForModelCatalog,
  selectionIdForPermissionCatalog,
} from '@/utils/workbench/catalog'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 运行状态是已有会话选择的权威来源；新会话保留用户草稿，不替用户猜测默认模型。 */
export function useRuntimeSelections(options: {
  selected: Ref<string>
  snapshot: Ref<SessionSnapshot | null>
  draft: Ref<WorkspaceDraft>
  models: Ref<RuntimeCatalog>
  permissions: Ref<RuntimeCatalog>
  permission: Ref<string>
  refresh(): Promise<void>
  report(message: string): void
}) {
  const saving = ref(false)
  const models = computed(() =>
    [...(options.models.value.models ?? options.models.value.items ?? [])].sort(
      (a, b) => Number(!!b.default) - Number(!!a.default),
    ),
  )
  const permissions = computed(
    () =>
      options.permissions.value.permissions ??
      options.permissions.value.items ??
      [],
  )
  const selection = computed(() =>
    modelIdsForSelectionId(
      options.models.value,
      options.draft.value.modelId,
      true,
    ),
  )
  const modelId = computed(
    () =>
      selection.value?.modelId ??
      (!options.selected.value && !options.draft.value.modelId
        ? models.value.find((item) => item.default && catalogItemEnabled(item))
            ?.id
        : '') ??
      '',
  )
  const modelUnavailable = computed(
    () =>
      !!options.draft.value.modelId &&
      !modelIdsForSelectionId(
        options.models.value,
        options.draft.value.modelId,
      ),
  )
  const modelExplicit = computed(() => !!options.draft.value.modelId)
  const permissionExplicit = computed(() => !!options.permission.value)
  const reasoningId = computed(() => selection.value?.reasoningId ?? '')
  const permissionId = computed(
    () =>
      permissionIdForSelectionId(
        options.permissions.value,
        options.permission.value,
        true,
      ) ||
      (!options.selected.value && !options.permission.value
        ? (permissions.value.find(
            (item) => item.default && catalogItemEnabled(item),
          )?.id ?? '')
        : ''),
  )
  const reasoning = computed(
    () =>
      models.value.find((item) => item.id === modelId.value)?.reasoningItems ??
      [],
  )
  const metadata = computed(() =>
    record(options.snapshot.value?.state.metadata),
  )
  const actualModel = computed(() => record(metadata.value.modelSelection))
  const actualPermission = computed(() =>
    record(metadata.value.permissionPreset),
  )
  const modelLabel = computed(() => {
    const model = models.value.find((item) => item.id === modelId.value)
    if (model) return catalogLabel(model)
    if (modelUnavailable.value) return '模型已不可用，请重新选择'
    if (typeof actualModel.value.model === 'string')
      return actualModel.value.model
    const fallback = models.value.find(
      (item) => item.default && catalogItemEnabled(item),
    )
    return fallback ? catalogLabel(fallback) : '选择模型'
  })
  const permissionLabel = computed(() => {
    const permission = permissions.value.find(
      (item) => item.id === permissionId.value,
    )
    if (permission) return catalogLabel(permission)
    if (typeof actualPermission.value.name === 'string')
      return actualPermission.value.name
    const fallback = permissions.value.find(
      (item) => item.default && catalogItemEnabled(item),
    )
    return fallback ? catalogLabel(fallback) : '选择权限'
  })
  function allowed(capabilityId: string): boolean {
    const snapshot = options.snapshot.value
    if (!options.selected.value) return true
    if (
      !snapshot ||
      !canControlSession(snapshot.session) ||
      snapshot.session.connectorStatus === 'offline'
    )
      return false
    const capabilities = snapshot.effectiveCapabilities.capabilities
    if (!Array.isArray(capabilities)) return false
    return capabilities.some((entry) => {
      const item = record(entry)
      return (
        item.capabilityId === capabilityId &&
        item.supported === true &&
        item.available === true &&
        item.allowed === true
      )
    })
  }
  const modelAllowed = computed(() => allowed('catalog.model') && !saving.value)
  const permissionAllowed = computed(
    () => allowed('catalog.permission') && !saving.value,
  )
  const reasoningAllowed = computed(
    () => allowed('catalog.effort') && modelAllowed.value,
  )

  function synchronize(): void {
    const id = options.selected.value,
      value = options.snapshot.value?.state.selections
    if (!id || options.snapshot.value?.session.id !== id) return
    const selections = record(value)
    // starting 阶段可能尚无 selections；只同步明确字段，不用未到达的状态抹掉用户选择。
    if (typeof selections.model === 'string' || selections.model === null)
      options.draft.value.modelId = selections.model ?? ''
    if (
      typeof selections.permission === 'string' ||
      selections.permission === null
    )
      options.permission.value = selections.permission ?? ''
  }
  watch(
    () =>
      [
        options.selected.value,
        options.snapshot.value?.state.selections,
      ] as const,
    () => {
      if (!saving.value) synchronize()
    },
    { immediate: true },
  )

  async function apply(
    key: 'model' | 'permission',
    selectionId: string,
  ): Promise<void> {
    if (saving.value) return
    const id = options.selected.value,
      identity = sessionController.generation
    if (!id) {
      if (key === 'model') options.draft.value.modelId = selectionId
      else options.permission.value = selectionId
      return
    }
    saving.value = true
    try {
      await conversationApi.selections(id, { [key]: selectionId })
      if (
        id !== options.selected.value ||
        identity !== sessionController.generation
      )
        return
      if (key === 'model') options.draft.value.modelId = selectionId
      else options.permission.value = selectionId
      await options.refresh()
    } catch (error) {
      if (
        id === options.selected.value &&
        identity === sessionController.generation
      )
        options.report(errorMessage(error))
    } finally {
      saving.value = false
      if (
        id === options.selected.value &&
        identity === sessionController.generation
      )
        synchronize()
    }
  }
  async function chooseModel(id: string, effort = ''): Promise<void> {
    if (!modelAllowed.value || (effort && !reasoningAllowed.value)) return
    if (!id && !options.selected.value) return apply('model', '')
    const value = selectionIdForModelCatalog(options.models.value, id, effort)
    if (value) await apply('model', value)
  }
  async function choosePermission(id: string): Promise<void> {
    if (!permissionAllowed.value) return
    if (!id && !options.selected.value) return apply('permission', '')
    const value = selectionIdForPermissionCatalog(options.permissions.value, id)
    if (value) await apply('permission', value)
  }
  return {
    saving,
    models,
    permissions,
    reasoning,
    modelId,
    reasoningId,
    permissionId,
    modelLabel,
    modelUnavailable,
    modelExplicit,
    permissionExplicit,
    permissionLabel,
    modelAllowed,
    permissionAllowed,
    reasoningAllowed,
    chooseModel,
    choosePermission,
  }
}
