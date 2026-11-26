<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { accountApi } from '@/api/account/account-api'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import SettingsCard from '@/components/settings/SettingsCard.vue'
import { sessionController } from '@/store/session-controller'
import { usePreferences } from '@/store/modules/preferences'
import { useCurrentProduct } from '@/composables/console/use-current-product'
import { errorMessage } from '@/utils/errors'

/** 弹窗锁定打开时的账号，取消和切换账号都不会提交注销。 */
const { tr } = usePreferences()
const router = useRouter()
const currentProduct = useCurrentProduct()
const owner = ref('')
const label = ref('')
const busy = ref(false)
const error = ref('')
function open() {
  const current = sessionController.current
  if (!current) return
  error.value = ''
  label.value =
    current.email || current.username || current.displayName || current.userId
  owner.value = current.userId
}
async function confirm() {
  if (busy.value || !owner.value) return
  const id = owner.value
  if (sessionController.current?.userId !== id) {
    owner.value = ''
    return
  }
  error.value = ''
  busy.value = true
  const product = currentProduct.value
  try {
    await accountApi.close(id)
    try {
      localStorage.removeItem(`superdsh.announcement.${id}`)
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(`superdsh:upload:${id}:`))
          localStorage.removeItem(key)
      }
    } catch {
      // 浏览器限制存储时，账号和服务端会话仍已注销。
    }
    owner.value = ''
    if (sessionController.current?.userId === id) {
      sessionController.clearForSignOut()
      await router.replace({ path: '/login', query: { product } })
      ElMessage.success(tr('账号已注销', 'Account deleted'))
    }
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <SettingsCard
    :title="tr('账号注销', 'Account deletion')"
    :description="
      tr(
        '永久删除办公和娱乐共用的账号及个人数据。',
        'Permanently delete your account and personal data across Office and Studio.',
      )
    "
  >
    <template #action>
      <el-button plain type="danger" @click="open">{{
        tr('注销账号', 'Delete account')
      }}</el-button>
    </template>
  </SettingsCard>
  <ManagementDialog
    :model-value="!!owner"
    :title="tr('确认注销账号？', 'Delete your account?')"
    :busy="busy"
    :error="error"
    :submit-text="tr('确认注销账号', 'Delete my account')"
    submit-type="danger"
    @update:model-value="owner = ''"
    @submit="confirm"
  >
    <p class="account-to-close">
      {{ tr('即将永久注销', 'Permanently deleting') }}
      <strong>{{ label }}</strong>
    </p>
    <ul class="closure-details">
      <li>
        {{
          tr(
            '所有设备将退出登录。个人资料、办公会话、作品和文件将被删除，无法恢复。',
            'You will be signed out on all devices. Your profile, conversations, projects and files will be permanently deleted.',
          )
        }}
      </li>
      <li>
        {{
          tr(
            '会员权益和剩余额度将一并清除。',
            'Your membership and remaining credits will be cleared.',
          )
        }}
      </li>
      <li>
        {{
          tr(
            '同一邮箱可以重新注册，按新用户领取 40 点体验额度。',
            'You can register again with this email and receive 40 trial credits as a new user.',
          )
        }}
      </li>
    </ul>
  </ManagementDialog>
</template>
<style scoped>
.account-to-close {
  margin: 0;
  overflow-wrap: anywhere;
}
.closure-details {
  display: grid;
  gap: var(--field-gap);
  margin: 0;
  padding-inline-start: 1.4em;
  line-height: 1.65;
}
</style>
