import { ref, watch } from 'vue'
import { devicesApi } from '@/api/devices/devices-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import type { Device } from '@/types/devices/devices'

/** 设备运维按服务器分页，只允许有连接管理权限的账号提交阻断。 */
export function useDeviceInventory() {
  const auth = useAuthStore(),
    mutation = useMutation(),
    page = ref(1),
    pageSize = ref(10),
    query = ref(''),
    search = ref(''),
    selected = ref<Device | null>(null),
    reason = ref('')
  const resource = useResource((signal) =>
    devicesApi.inventory(page.value, pageSize.value, search.value, signal),
  )
  watch([page, pageSize, search], () => {
    void resource.reload()
  })
  watch(
    () => auth.generation,
    () => {
      selected.value = null
      reason.value = ''
    },
  )
  function filter(): void {
    search.value = query.value.trim()
    page.value = 1
    void resource.reload()
  }
  function select(device: Device): void {
    selected.value = device
    reason.value = ''
    mutation.error.value = ''
  }
  async function operate(): Promise<void> {
    const device = selected.value
    if (!device || !auth.can('devices.connection.manage')) return
    if (
      await mutation.run(() =>
        device.blockedAt
          ? devicesApi.resume(device.id)
          : devicesApi.block(device.id, reason.value.trim()),
      )
    ) {
      selected.value = null
      await resource.reload()
    }
  }
  return {
    auth,
    resource,
    mutation,
    page,
    pageSize,
    query,
    selected,
    reason,
    filter,
    select,
    operate,
  }
}
