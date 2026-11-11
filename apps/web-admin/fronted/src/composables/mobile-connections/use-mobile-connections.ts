import { computed, onScopeDispose, ref, watch } from 'vue'
import QRCode from 'qrcode'
import { accountApi, type LoginSession } from '@/api/account/account-api'
import { mobileApi } from '@/api/mobile-connections/mobile-api'
import {
  mobileLoginProtocol,
  type MobileGrant,
  type MobileStatus,
} from '@/types/mobile-connections/mobile'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { sessionController } from '@/store/session-controller'
import { useAuthStore } from '@/store/modules/auth-store'

/** 二维码仅在当前身份页内存存在；轮询串行，关闭对话框和换号立即取消。 */
export function useMobileConnections() {
  const auth = useAuthStore(),
    resource = useResource(accountApi.sessions),
    mutation = useMutation()
  const opened = ref(false),
    grant = ref<MobileGrant | null>(null),
    status = ref<MobileStatus | null>(null),
    image = ref(''),
    selected = ref<LoginSession | null>(null)
  const page = ref(1),
    pageSize = ref(10)
  const sessions = computed(() =>
    (resource.data.value?.sessions ?? [])
      .filter(
        (value) =>
          ['mobile', 'superdsh android', 'agents-anywhere-mobile'].includes(
            value.clientName.toLowerCase().trim(),
          ) && Date.parse(value.expiresAt) > Date.now(),
      )
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      ),
  )
  const pageRows = computed(() =>
    sessions.value.slice(
      (page.value - 1) * pageSize.value,
      page.value * pageSize.value,
    ),
  )
  watch(pageSize, () => {
    page.value = 1
  })
  let timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | null = null
  function stop() {
    clearTimeout(timer)
    controller?.abort()
    controller = null
  }
  function close() {
    stop()
    grant.value = null
    status.value = null
    image.value = ''
    opened.value = false
  }
  async function poll() {
    if (!opened.value || !grant.value) return
    const token = grant.value.loginToken,
      generation = sessionController.generation
    controller = new AbortController()
    try {
      const result = await mobileApi.status(token, controller.signal)
      if (
        generation !== sessionController.generation ||
        grant.value?.loginToken !== token ||
        !opened.value
      )
        return
      status.value = result
      if (result.status === 'consumed') {
        await resource.reload()
        return
      }
      if (['expired', 'rejected'].includes(result.status)) return
    } catch {
      if (controller.signal.aborted) return
    }
    timer = setTimeout(() => void poll(), 1500)
  }
  async function generate() {
    stop()
    grant.value = null
    image.value = ''
    status.value = null
    let next: MobileGrant | null = null,
      qr = ''
    if (
      await mutation.run(async () => {
        next = await mobileApi.create()
        qr = await QRCode.toDataURL(
          JSON.stringify({
            ...mobileLoginProtocol,
            webUrl: location.origin,
            ...next,
          }),
          { width: 280, margin: 2, errorCorrectionLevel: 'M' },
        )
      })
    ) {
      grant.value = next
      image.value = qr
      opened.value = true
      void poll()
    }
  }
  async function confirm(approved: boolean) {
    if (grant.value) {
      let result: MobileStatus | null = null
      if (
        await mutation.run(async () => {
          result = await mobileApi.confirm(grant.value!.loginToken, approved)
        })
      )
        status.value = result
    }
  }
  async function revoke() {
    const value = selected.value
    if (value && (await mutation.run(() => accountApi.revoke(value.id)))) {
      selected.value = null
      if (value.current) sessionController.clear()
      else await resource.reload()
    }
  }
  watch(() => auth.generation, close)
  onScopeDispose(stop)
  return {
    resource,
    mutation,
    opened,
    grant,
    status,
    image,
    selected,
    sessions,
    page,
    pageSize,
    pageRows,
    generate,
    confirm,
    revoke,
    close,
  }
}
