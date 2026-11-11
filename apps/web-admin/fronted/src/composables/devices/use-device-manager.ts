import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { devicesApi } from '@/api/devices/devices-api'
import { useAuthStore } from '@/store/modules/auth-store'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import {
  runtimeDraft,
  configurationErrors,
  copyConfiguration,
} from '@/utils/devices/runtime-config'
import type {
  Device,
  DeviceDraft,
  DeviceRuntime,
  RuntimeType,
} from '@/types/devices/devices'

/** 本人设备的配对、命名和实例配置；固定服务器 DSH 不开放删除或停用。 */
export function useDeviceManager(changed: () => void) {
  const auth = useAuthStore(),
    mutation = useMutation(),
    selected = ref<Device | null>(null)
  const resource = useResource((signal) => devicesApi.list(signal))
  const runtimes = useResource(async (signal) => {
    const id = selected.value?.id
    if (!id) return { runtimes: [], runtimeTypes: [] }
    const [instances, types] = await Promise.all([
      devicesApi.runtimes(id, signal),
      devicesApi.types(id, signal),
    ])
    return { ...instances, ...types }
  })
  const pairing = ref(false),
    pairingCode = ref(''),
    deviceDraft = reactive<DeviceDraft>({
      name: '',
      connectorKind: 'desktop',
      executorKind: 'desktop',
    })
  const renaming = ref<Device | null>(null),
    name = ref(''),
    revoking = ref<Device | null>(null),
    deleting = ref<Device | null>(null),
    credential = ref<{ connectorToken: string; tokenPrefix: string } | null>(
      null,
    ),
    credentialNotice = ref('')
  const editing = ref<DeviceRuntime | 'new' | null>(null),
    draft = reactive(runtimeDraft()),
    clearing = ref<DeviceRuntime | null>(null),
    runtimeRename = ref<DeviceRuntime | null>(null),
    runtimeName = ref('')
  const descriptor = computed<RuntimeType | undefined>(() =>
    editing.value && editing.value !== 'new'
      ? editing.value
      : runtimes.data.value?.runtimeTypes.find(
          (item) => item.runtimeType === draft.runtimeType,
        ),
  )
  const mutable = computed(
    () =>
      auth.can('devices.manage') &&
      selected.value?.executorKind !== 'server-agent',
  )
  watch(selected, () => {
    editing.value = null
    clearing.value = null
    runtimeRename.value = null
    void runtimes.reload()
  })
  watch(
    () => draft.runtimeType,
    (type, previous) => {
      if (editing.value === 'new' && type !== previous) {
        const selectedType = runtimes.data.value?.runtimeTypes.find(
          (item) => item.runtimeType === type,
        )
        Object.assign(draft, runtimeDraft(selectedType))
      }
    },
  )
  watch(
    () => auth.generation,
    () => {
      selected.value = null
      pairing.value = false
      pairingCode.value = ''
      renaming.value = null
      revoking.value = null
      deleting.value = null
      credential.value = null
      credentialNotice.value = ''
      editing.value = null
      clearing.value = null
      runtimeRename.value = null
      deviceDraft.name = ''
    },
  )
  async function reload(): Promise<void> {
    await Promise.all([resource.reload(), runtimes.reload()])
    changed()
  }
  async function pair(): Promise<void> {
    if (
      await mutation.run(() =>
        devicesApi.pair({ ...deviceDraft, code: pairingCode.value.trim() }),
      )
    ) {
      pairing.value = false
      pairingCode.value = ''
      await reload()
    }
  }
  function rename(device: Device): void {
    renaming.value = device
    name.value = device.name
    mutation.error.value = ''
  }
  async function saveName(): Promise<void> {
    const value = renaming.value
    if (
      value &&
      (await mutation.run(() => devicesApi.rename(value.id, name.value.trim())))
    ) {
      renaming.value = null
      await reload()
    }
  }
  async function revoke(): Promise<void> {
    const value = revoking.value
    if (
      !value ||
      value.executorKind === 'server-agent' ||
      !auth.can('devices.manage')
    )
      return
    let next: { connectorToken: string; tokenPrefix: string } | null = null
    if (
      await mutation.run(async () => {
        next = await devicesApi.revoke(value.id)
      })
    ) {
      revoking.value = null
      credential.value = next
      credentialNotice.value = ''
      await reload()
    }
  }
  /** 删除与轮换凭据分开确认；只有删除成功后才清理当前选中的设备。 */
  async function remove(): Promise<void> {
    const value = deleting.value
    if (
      !value ||
      value.executorKind === 'server-agent' ||
      !auth.can('devices.manage')
    )
      return
    if (await mutation.run(() => devicesApi.remove(value.id))) {
      deleting.value = null
      if (selected.value?.id === value.id) selected.value = null
      await reload()
    }
  }
  async function copyCredential(): Promise<void> {
    if (!credential.value) return
    try {
      await navigator.clipboard.writeText(credential.value.connectorToken)
      credentialNotice.value = '已复制凭据'
    } catch {
      credentialNotice.value = '复制失败，请手动复制凭据'
    }
  }
  onScopeDispose(() => {
    credential.value = null
  })
  function edit(value: DeviceRuntime | 'new'): void {
    editing.value = value
    const type =
      value === 'new'
        ? runtimes.data.value?.runtimeTypes.find(
            (item) => item.available !== false,
          )
        : value
    Object.assign(
      draft,
      runtimeDraft(type, value === 'new' ? undefined : value),
    )
    mutation.error.value = ''
  }
  async function discover(): Promise<void> {
    const device = selected.value
    if (device && (await mutation.run(() => devicesApi.discover(device.id))))
      await runtimes.reload()
  }
  async function saveRuntime(): Promise<void> {
    const device = selected.value,
      value = editing.value
    if (!device || !value || !mutable.value) return
    if (!descriptor.value?.schema) {
      mutation.error.value = '设备未提供配置 Schema，请重新发现后重试'
      return
    }
    const errors = configurationErrors(descriptor.value?.schema, draft.config)
    if (errors.length) {
      mutation.error.value = errors.join('；')
      return
    }
    const config = copyConfiguration(draft.config) as Record<string, unknown>
    if (
      await mutation.run(() =>
        value === 'new'
          ? devicesApi.createRuntime(device.id, { ...draft, config })
          : devicesApi.config(device.id, value, config),
      )
    ) {
      editing.value = null
      await runtimes.reload()
    }
  }
  async function toggle(runtime: DeviceRuntime): Promise<void> {
    const device = selected.value
    if (
      device &&
      mutable.value &&
      (await mutation.run(() => devicesApi.active(device.id, runtime)))
    )
      await runtimes.reload()
  }
  async function clearConfig(): Promise<void> {
    const device = selected.value,
      value = clearing.value
    if (
      device &&
      value &&
      mutable.value &&
      (await mutation.run(() => devicesApi.clearConfig(device.id, value)))
    ) {
      clearing.value = null
      await runtimes.reload()
    }
  }
  function renameInstance(runtime: DeviceRuntime): void {
    runtimeRename.value = runtime
    runtimeName.value = runtime.name
    mutation.error.value = ''
  }
  async function saveRuntimeName(): Promise<void> {
    const device = selected.value,
      value = runtimeRename.value
    if (
      device &&
      value &&
      (await mutation.run(() =>
        devicesApi.renameRuntime(device.id, value, runtimeName.value.trim()),
      ))
    ) {
      runtimeRename.value = null
      await runtimes.reload()
    }
  }
  /** 打开配对表单时清除旧操作错误，保留尚未提交的配对码。 */
  function openPairing(): void {
    pairing.value = true
    mutation.error.value = ''
  }
  return {
    auth,
    resource,
    mutation,
    selected,
    runtimes,
    pairing,
    openPairing,
    pairingCode,
    deviceDraft,
    renaming,
    name,
    revoking,
    deleting,
    credential,
    credentialNotice,
    copyCredential,
    remove,
    editing,
    draft,
    clearing,
    runtimeRename,
    runtimeName,
    descriptor,
    mutable,
    reload,
    pair,
    rename,
    saveName,
    revoke,
    edit,
    discover,
    saveRuntime,
    toggle,
    clearConfig,
    renameInstance,
    saveRuntimeName,
  }
}
