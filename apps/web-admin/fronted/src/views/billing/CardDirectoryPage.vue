<script setup lang="ts">
import { ref } from 'vue'
import { cardTypesApi } from '@/api/billing/card-types-api'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useCurrentProduct } from '@/composables/console/use-current-product'
import { useResource } from '@/composables/use-resource'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import type { CardType } from '@/types/billing/membership'
import CardTypeEditor from './components/CardTypeEditor.vue'
import CreditTicket from './components/CreditTicket.vue'
import '@/assets/styles/billing.css'
const auth = useAuthStore()
const product = useCurrentProduct()
const { tr } = usePreferences()
const { data, loading, error, reload } = useResource(cardTypesApi.list)
const editor = ref<{ card: CardType | null } | null>(null)
const notice = ref('')
async function saved() {
  editor.value = null
  notice.value = tr('卡种已保存', 'Card type saved')
  await reload()
}
</script>
<template>
  <section class="page settings-page ticket-page">
    <PageHeader :title="tr('额度卡管理', 'Credit card management')" />
    <div class="ticket-directory-intro">
      <p>
        {{
          tr(
            '维护卡面与固定面额，修改仅用于之后发放的卡。',
            'Manage artwork and fixed face values. Changes apply to future issues.',
          )
        }}
      </p>
      <el-button
        v-if="auth.can('billing.plans.manage')"
        type="primary"
        @click="editor = { card: null }"
        >{{ tr('新建卡种', 'New card type') }}</el-button
      >
    </div>
    <ResourceStatus
      :loading="loading"
      :has-data="!!data"
      :error="error"
      :empty="data?.items.length === 0"
      :empty-title="tr('暂无额度卡种', 'No card types yet')"
      @retry="reload"
    />
    <el-alert
      v-if="notice"
      type="success"
      :title="notice"
      @close="notice = ''"
    />
    <ul v-if="data?.items.length" class="ticket-catalog">
      <li v-for="card in data.items" :key="card.id">
        <CreditTicket
          :image="card.image"
          :name="card.name"
          :points="card.points"
        />
        <div class="ticket-caption">
          <h2>{{ card.name }}</h2>
          <span>{{
            card.enabled ? tr('启用中', 'Active') : tr('已停用', 'Inactive')
          }}</span>
          <el-button
            v-if="auth.can('billing.plans.manage')"
            @click="editor = { card }"
            >{{ tr('编辑', 'Edit') }}</el-button
          >
        </div>
      </li>
    </ul>
    <footer
      v-if="
        auth.can('products.' + product + '.members.manage') &&
        auth.can('billing.adjustments.create')
      "
      class="ticket-footnote"
    >
      {{ tr('发放额度卡请前往', 'To issue a card, visit') }}
      <router-link :to="{ path: '/product/members', query: { product } }">{{
        tr('成员与账号', 'Members and accounts')
      }}</router-link>
    </footer>
    <CardTypeEditor
      v-if="editor"
      :card="editor.card"
      @close="editor = null"
      @saved="saved"
    />
  </section>
</template>
