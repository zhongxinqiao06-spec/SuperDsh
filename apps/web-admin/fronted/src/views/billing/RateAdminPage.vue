<script setup lang="ts">
import { ref, watch } from 'vue'
import { pricingApi } from '@/api/billing/pricing-api'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { useAuthStore } from '@/store/modules/auth-store'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import DataTable from '@/components/management/DataTable.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import RateEditor from './components/RateEditor.vue'
import { billingTime } from '@/utils/billing/change-labels'
import type { RateVersion } from '@/types/billing/pricing'
import '@/assets/styles/billing.css'
const { tr } = usePreferences(),
  auth = useAuthStore()
const page = ref(1),
  size = ref(10),
  input = ref(''),
  search = ref(''),
  state = ref('effective'),
  payer = ref(''),
  editor = ref<{ row: RateVersion | null } | null>(null),
  notice = ref('')
const { data, error, loading, reload } = useResource((signal) =>
  pricingApi.rates(
    {
      page: page.value,
      pageSize: size.value,
      state: state.value,
      payer: payer.value || undefined,
      search: search.value,
    },
    signal,
  ),
)
watch([page, size, search, state, payer], () => {
  data.value = null
  void reload()
})
function filter() {
  page.value = 1
  search.value = input.value.trim()
  void reload()
}
function done(published: boolean, scheduled: boolean) {
  editor.value = null
  page.value = 1
  state.value = published ? (scheduled ? 'scheduled' : 'effective') : 'draft'
  notice.value = published
    ? tr('费率已发布', 'Rate published')
    : tr('费率草稿已保存', 'Rate draft saved')
  void reload()
}
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader :title="tr('模型扣点价目', 'Model rates')" />
    <FilterBar class="toolbar billing-directory-filter" @submit="filter">
      <el-input
        v-model="input"
        clearable
        :aria-label="tr('搜索费率条件', 'Search rate conditions')"
        :placeholder="
          tr('搜索模型、能力或规格', 'Search model, capability or spec')
        "
      />
      <el-button native-type="submit">{{ tr('搜索', 'Search') }}</el-button>
      <select
        v-model="payer"
        class="native-control"
        :aria-label="tr('筛选承担方', 'Filter by payer')"
        @change="page = 1"
      >
        <option value="">{{ tr('全部承担方', 'All payers') }}</option>
        <option value="platform">{{ tr('平台模型', 'Platform') }}</option>
        <option value="personal">
          {{ tr('本人凭据', 'Personal credentials') }}
        </option>
      </select>
      <select
        v-model="state"
        class="native-control"
        :aria-label="tr('版本状态', 'Version status')"
        @change="page = 1"
      >
        <option value="effective">{{ tr('当前生效', 'Current') }}</option>
        <option value="draft">{{ tr('待发布草稿', 'Drafts') }}</option>
        <option value="scheduled">{{ tr('定时发布', 'Scheduled') }}</option>
        <option value="all">{{ tr('全部修订', 'All revisions') }}</option>
      </select>
      <el-button @click="reload()">{{ tr('刷新', 'Refresh') }}</el-button
      ><el-button
        v-if="auth.can('billing.rates.manage')"
        type="primary"
        @click="editor = { row: null }"
        >{{ tr('新增费率', 'Create rate') }}</el-button
      >
    </FilterBar>
    <el-alert
      v-if="notice"
      type="success"
      :title="notice"
      @close="notice = ''"
    />
    <ResourceStatus :loading="loading" :error="error" @retry="reload" />
    <ManagementList :page="page" :page-size="size"
      ><DataTable mobile-cards :label="tr('费率版本', 'Rate versions')"
        ><thead>
          <tr>
            <th>{{ tr('模型与规格', 'Model and specification') }}</th>
            <th>{{ tr('承担方', 'Payer') }}</th>
            <th>{{ tr('创作点单价', 'Unit price') }}</th>
            <th>{{ tr('版本', 'Version') }}</th>
            <th>{{ tr('操作', 'Actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in data?.items" :key="row.id">
            <td>
              <strong
                >{{ row.payload.terms.capability }} ·
                {{ row.payload.terms.spec }}</strong
              ><small
                >{{
                  row.payload.terms.product === 'office'
                    ? tr('办公', 'Office')
                    : tr('娱乐', 'Studio')
                }}
                ·
                {{
                  row.payload.terms.model === '*'
                    ? tr('通用模型', 'All models')
                    : row.payload.terms.model
                }}<template v-if="row.payload.terms.modelRevision">
                  · r{{ row.payload.terms.modelRevision }}</template
                ></small
              >
            </td>
            <td :data-label="tr('承担方', 'Payer')">
              {{
                row.payload.terms.payer === 'platform'
                  ? tr('平台模型', 'Platform')
                  : tr('本人凭据', 'Personal credentials')
              }}
            </td>
            <td :data-label="tr('单价', 'Price')">
              {{ row.payload.terms.unitPoints }} {{ tr('点', 'credits') }} /
              {{ row.payload.terms.unitSize }}
              {{
                {
                  second: tr('秒', 'sec'),
                  image: tr('张', 'images'),
                  call: tr('次', 'calls'),
                  character: tr('字', 'characters'),
                }[row.payload.terms.unit]
              }}
            </td>
            <td :data-label="tr('版本', 'Version')">
              v{{ row.revision
              }}<small>{{
                row.effectiveAt
                  ? billingTime(row.effectiveAt)
                  : tr('草稿', 'Draft')
              }}</small>
            </td>
            <td class="actions">
              <el-button link @click="editor = { row }">{{
                tr('查看与试算', 'Inspect and simulate')
              }}</el-button>
            </td>
          </tr>
          <tr v-if="data?.total === 0">
            <td colspan="5" class="empty-cell">
              {{ tr('没有符合条件的费率', 'No matching rates') }}
            </td>
          </tr>
        </tbody></DataTable
      >
      <template #pagination
        ><ManagementPagination
          v-model:current-page="page"
          v-model:page-size="size"
          :page-sizes="[10, 20, 50]"
          :total="data?.total ?? 0"
          :loading="loading" /></template
    ></ManagementList>
    <RateEditor
      v-if="editor"
      :row="editor.row"
      :editable="auth.can('billing.rates.manage')"
      @saved="done"
      @close="editor = null"
    />
  </section>
</template>
