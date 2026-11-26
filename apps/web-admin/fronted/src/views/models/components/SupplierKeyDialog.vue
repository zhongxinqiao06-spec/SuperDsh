<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { checkKeyTransport, modelsApi } from '@/api/models/models-api'
import { passwordProof } from '@/api/auth/auth-api'
import { useAuthStore } from '@/store/modules/auth-store'
import { errorMessage } from '@/utils/errors'
import type { ModelConnection } from '@/types/models/models'

/** 明文只驻留在已确认身份的弹窗实例中，关闭、超时或切换账号均清除。 */
const props = defineProps<{ connection: ModelConnection }>()
const emit = defineEmits<{ close: [] }>()
const auth = useAuthStore()
const password = ref(''),
  key = ref(''),
  error = ref(''),
  busy = ref(false)
const controller = new AbortController()
let timer: ReturnType<typeof setTimeout> | undefined
function clear() {
  controller.abort()
  clearTimeout(timer)
  key.value = ''
  password.value = ''
}
function close() {
  clear()
  emit('close')
}
watch(() => auth.generation, close, { flush: 'sync' })
onScopeDispose(clear)
async function reveal() {
  if (!password.value || busy.value || key.value) return
  busy.value = true
  error.value = ''
  try {
    checkKeyTransport()
    const proof = await passwordProof(
      auth.session?.username ?? auth.session?.email ?? '',
      password.value,
      controller.signal,
    )
    password.value = ''
    const result = await modelsApi.revealKey(
      props.connection.id,
      proof,
      controller.signal,
    )
    if (!controller.signal.aborted) {
      key.value = result.apiKey
      timer = setTimeout(close, 45000)
    }
  } catch (e) {
    if (!controller.signal.aborted) error.value = errorMessage(e)
  } finally {
    busy.value = false
    password.value = ''
  }
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="connection.name + ' · 查看 API Key'"
    width="min(496px, calc(100vw - 32px))"
    :readonly="Boolean(key)"
    :submit-disabled="!password || busy"
    :error="error"
    :submit-text="busy ? '正在验证…' : '确认并查看'"
    :navigation-guard="false"
    @update:model-value="!$event && close()"
    @submit="reveal"
  >
    <template v-if="key"
      ><label class="field"
        >当前 API Key<input
          class="native-control"
          readonly
          :value="key"
          autocomplete="off"
          spellcheck="false" /></label
      ><small>45 秒后自动关闭。</small></template
    >
    <template v-else
      ><label class="field"
        >当前管理员账号密码<el-input
          v-model="password"
          type="password"
          autocomplete="current-password"
      /></label>
    </template>
  </ManagementDialog>
</template>
