<script setup lang="ts">
import DateTime from '@/components/base/DateTime.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import DataTable from '@/components/management/DataTable.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import { useConversationHistory } from '@/composables/workbench/use-conversation-history'
import { onScopeDispose, ref } from 'vue'
import {
  confirmSessionRemoval,
  useSessionActions,
} from '@/composables/workbench/use-session-actions'
import { useAuthStore } from '@/store/modules/auth-store'
import { useDraftStore } from '@/store/modules/draft-store'
import { sessionStatusLabel } from '@/utils/workbench/session-access'
import SessionActionMenu from './components/SessionActionMenu.vue'
const vm = useConversationHistory()
const auth = useAuthStore()
const drafts = useDraftStore()
const error = ref('')
const controller = new AbortController()
onScopeDispose(() => controller.abort())
const actions = useSessionActions({
  signal: controller.signal,
  refresh: vm.resource.reload,
  remove: async (row) => {
    const identity = auth.generation
    if (
      await confirmSessionRemoval(
        row,
        () =>
          identity === auth.generation &&
          !controller.signal.aborted &&
          auth.can('sessions.run'),
      )
    ) {
      drafts.remove(row.id)
      await vm.resource.reload()
    }
  },
  report: (message) => {
    error.value = message
  },
})
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader title="历史会话" /><el-alert
      v-if="error"
      type="error"
      :title="error"
      @close="error = ''"
    />
    <FilterBar @submit="vm.filter"
      ><el-input
        v-model="vm.query.value"
        aria-label="搜索会话"
        placeholder="搜索会话标题"
        clearable
      /><el-radio-group v-model="vm.archived.value" aria-label="会话范围"
        ><el-radio-button :value="false">近期会话</el-radio-button
        ><el-radio-button :value="true">已归档</el-radio-button></el-radio-group
      ><el-button native-type="submit">搜索</el-button></FilterBar
    >
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    />
    <ManagementList :page="vm.index.value + 1" :page-size="vm.limit.value"
      ><DataTable mobile-cards label="会话列表">
        <thead>
          <tr>
            <th>会话名称</th>
            <th>状态</th>
            <th>最近活动</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="session in vm.resource.data.value?.sessions"
            :key="session.id"
          >
            <td>
              <strong>{{ session.title }}</strong>
            </td>
            <td data-label="状态">{{ sessionStatusLabel(session.status) }}</td>
            <td data-label="最近活动">
              <DateTime :value="session.lastActivityAt ?? session.sortAt" />
            </td>
            <td data-label="操作">
              <router-link
                :to="'/workspace/session/' + encodeURIComponent(session.id)"
                >打开会话</router-link
              >
              <SessionActionMenu
                v-if="auth.can('sessions.run')"
                :session="session"
                :busy="actions.editingSession.value"
                @action="actions.updateSession(session, $event)"
              />
            </td>
          </tr>
          <tr
            v-if="
              vm.resource.data.value && !vm.resource.data.value.sessions.length
            "
          >
            <td colspan="4" class="empty-cell">没有匹配的会话</td>
          </tr>
        </tbody></DataTable
      ><template #pagination
        ><nav
          v-if="vm.index.value || vm.resource.data.value?.sessions.length"
          class="management-pagination"
          aria-label="会话分页"
        >
          <span>第 {{ vm.index.value + 1 }} 页</span>
          <div class="pagination-controls">
            <label
              >每页
              <select
                v-model.number="vm.limit.value"
                class="native-control native-control--small"
              >
                <option
                  v-for="limit in [10, 20, 50]"
                  :key="limit"
                  :value="limit"
                >
                  {{ limit }}
                </option>
              </select></label
            >
            <el-button
              :disabled="vm.resource.loading.value || !vm.index.value"
              @click="vm.index.value--"
              >上一页</el-button
            ><el-button
              :disabled="
                vm.resource.loading.value || !vm.resource.data.value?.nextCursor
              "
              @click="vm.next"
              >下一页</el-button
            >
          </div>
        </nav></template
      ></ManagementList
    >
  </section>
</template>
