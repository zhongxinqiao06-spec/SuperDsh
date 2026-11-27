<script setup lang="ts">
import { computed, onMounted, onScopeDispose } from 'vue'
import { useRouter } from 'vue-router'
import { registrationNoticeApi } from '@/api/billing/registration-notice-api'
import { useMutation } from '@/composables/use-mutation'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { billingTime } from '@/utils/billing/change-labels'
import CreditTicket from './CreditTicket.vue'

/** 从注册直达或随后登录都会查同一张已发卡。确认写入成功后才关闭或跳转。 */
const props = defineProps<{ cardsPath: string }>()
const router = useRouter()
const { tr } = usePreferences()
const resource = useResource(registrationNoticeApi.unread)
const mutation = useMutation()
const card = computed(() =>
  resource.data.value?.id ? resource.data.value : null,
)
async function acknowledge(viewCards: boolean) {
  if (!card.value) return
  const id = card.value.id
  if (await mutation.run(() => registrationNoticeApi.acknowledge(id))) {
    resource.data.value = null
    if (viewCards) await router.push(props.cardsPath)
  }
}
function retryUnread() {
  if (resource.error.value && !resource.loading.value) void resource.reload()
}
onMounted(() => {
  window.addEventListener('focus', retryUnread)
  window.addEventListener('online', retryUnread)
})
onScopeDispose(() => {
  window.removeEventListener('focus', retryUnread)
  window.removeEventListener('online', retryUnread)
})
</script>

<template>
  <el-dialog
    v-if="card"
    :model-value="true"
    class="management-dialog"
    :title="tr('注册赠卡已到账', 'Your welcome card is ready')"
    width="min(464px, calc(100vw - 32px))"
    :show-close="!mutation.busy.value"
    :close-on-click-modal="false"
    :close-on-press-escape="!mutation.busy.value"
    :before-close="() => acknowledge(false)"
  >
    <div class="stack">
      <CreditTicket
        :image="card.image"
        :points="card.points"
        :name="card.name"
      />
      <strong
        >{{ card.name }} · {{ card.points.toLocaleString() }}
        {{ tr('创作点', 'credits') }}</strong
      >
      <p>
        {{
          tr(
            '会员和普通额度不足时，这张卡会自动抵扣差额。',
            'This card automatically covers any shortfall after membership and regular credits.',
          )
        }}
      </p>
      <small
        >{{ tr('有效期至', 'Valid until') }} {{ billingTime(card.expiresAt) }}
      </small>
      <el-alert
        v-if="mutation.error.value"
        :title="mutation.error.value"
        type="error"
        :closable="false"
      />
    </div>
    <template #footer>
      <div class="dialog-actions">
        <el-button
          :disabled="mutation.busy.value"
          @click="acknowledge(false)"
          >{{ tr('我知道了', 'Got it') }}</el-button
        >
        <el-button
          type="primary"
          :loading="mutation.busy.value"
          @click="acknowledge(true)"
          >{{ tr('查看我的额度卡', 'View my cards') }}</el-button
        >
      </div>
    </template>
  </el-dialog>
  <slot v-else-if="!resource.loading.value" />
</template>
