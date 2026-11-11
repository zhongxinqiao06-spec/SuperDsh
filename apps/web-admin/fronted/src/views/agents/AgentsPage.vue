<script setup lang="ts">
import ManagementList from '@/components/management/ManagementList.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import DataTable from '@/components/management/DataTable.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useAgents } from '@/composables/agents/use-agents'
import { ref } from 'vue'
import DateTime from '@/components/base/DateTime.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import AgentRowActions from '@/views/agents/components/AgentRowActions.vue'
import {
  agentFieldIssue,
  type AgentFieldIssue,
} from '@/utils/agents/editor-validation'
import type { AgentDefinition, AgentDraft } from '@/types/agents/agents'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import AgentEditor from '@/views/agents/components/AgentEditor.vue'
/** 智能体管理页只装配声明资源和操作，不包含第二执行引擎。 */
const vm = useAgents()
const editor = ref<InstanceType<typeof AgentEditor>>()
const issue = ref<AgentFieldIssue>()
async function save(): Promise<void> {
  issue.value = agentFieldIssue(vm.draft)
  if (issue.value) await editor.value?.focusIssue(issue.value)
  await vm.save()
}
function edit(agent: AgentDefinition | 'new'): void {
  issue.value = undefined
  vm.edit(agent)
}
/** 字段修正后移除对应的本地校验；服务端保存错误仍保留供重试。 */
function updateDraft(value: AgentDraft): void {
  vm.updateDraft(value)
  if (issue.value && value[issue.value.field].trim()) {
    issue.value = undefined
    vm.mutation.error.value = ''
  }
}
function action(agent: AgentDefinition, key: string): void {
  if (vm.mutation.busy.value) return
  switch (key) {
    case 'edit':
      edit(agent)
      break
    case 'trial':
      void vm.trial(agent)
      break
    case 'check':
      void vm.check(agent)
      break
    case 'publish':
      void vm.publish(agent)
      break
    case 'delete':
      vm.deleting.value = agent
      break
  }
}
</script>

<template>
  <section class="page paged-page management-page resource-management-page">
    <PageHeader title="智能体列表" />
    <el-alert
      v-if="!vm.allowed.value"
      type="warning"
      title="当前账号没有智能体管理权限"
      :closable="false"
    />
    <FilterBar class="toolbar" @submit="vm.filter">
      <el-input
        v-model="vm.query.value"
        placeholder="搜索智能体名称"
        aria-label="搜索智能体"
        clearable
      /><el-button native-type="submit">搜索</el-button>
      <el-button
        :disabled="!vm.allowed.value || vm.mutation.busy.value"
        @click="vm.initialize(true)"
        >复制新版示例</el-button
      >
      <el-button v-if="vm.allowed.value" type="primary" @click="edit('new')"
        >新增智能体</el-button
      >
    </FilterBar>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :has-data="Boolean(vm.resource.data.value)"
      :error="vm.resource.error.value || vm.catalog.error.value"
      @retry="vm.reload"
    /><el-alert
      v-if="vm.mutation.error.value"
      type="error"
      :title="vm.mutation.error.value"
      :closable="false"
    />
    <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <DataTable label="数据列表" table-class="agents-table">
        <thead>
          <tr>
            <th>名称与用途</th>
            <th>状态</th>
            <th>配置</th>
            <th>最近更新</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="agent in vm.resource.data.value?.items ?? []"
            :key="agent.id"
          >
            <td class="resource-description">
              <strong>{{ agent.name }}</strong>
              <small class="description-preview">{{
                agent.description || '尚未填写用途说明'
              }}</small>
              <details
                v-if="agent.description || agent.recommendedPrompts?.length"
              >
                <summary>查看完整说明</summary>
                <p>{{ agent.description }}</p>
                <p v-if="agent.recommendedPrompts?.length">
                  试用指令：{{ agent.recommendedPrompts[0] }}
                </p>
              </details>
            </td>
            <td>
              <span
                class="status-badge"
                :class="{ 'is-active': agent.published }"
                >{{ agent.published ? '已发布' : '草稿' }}</span
              ><small>版本 {{ agent.version }}</small>
            </td>
            <td class="resource-summary">
              <p>
                知识库 {{ agent.knowledgeBaseIds?.length ?? 0 }} · 直接资料
                {{
                  (agent.knowledgeAssetIds?.length ?? 0) +
                  (agent.templateAssetIds?.length ?? 0)
                }}
              </p>
              <p>
                技能 {{ agent.skillIds?.length ?? 0 }} · 工具
                {{ agent.toolIds?.length ?? 0 }}
              </p>
            </td>
            <td><DateTime :value="agent.updatedAt" /></td>
            <td>
              <AgentRowActions
                :published="agent.published"
                :can-run="vm.auth.can('sessions.run')"
                :busy="vm.mutation.busy.value"
                @action="action(agent, $event)"
              />
            </td>
          </tr>
          <tr
            v-if="
              !vm.resource.loading.value &&
              !vm.resource.error.value &&
              !vm.resource.data.value?.items.length
            "
          >
            <td colspan="5" class="empty-cell">
              暂无智能体，点击“新增智能体”开始配置。
            </td>
          </tr>
        </tbody>
        <template #mobile>
          <article
            v-for="agent in vm.resource.data.value?.items ?? []"
            :key="agent.id"
            class="resource-card"
          >
            <header>
              <h3>{{ agent.name }}</h3>
              <span
                class="status-badge"
                :class="{ 'is-active': agent.published }"
                >{{ agent.published ? '已发布' : '草稿' }}</span
              >
            </header>
            <p>{{ agent.description || '尚未填写用途说明' }}</p>
            <div class="resource-summary">
              知识库 {{ agent.knowledgeBaseIds?.length ?? 0 }} · 技能
              {{ agent.skillIds?.length ?? 0 }} · 工具
              {{ agent.toolIds?.length ?? 0 }}
            </div>
            <footer>
              <small>版本 {{ agent.version }}</small
              ><AgentRowActions
                :published="agent.published"
                :can-run="vm.auth.can('sessions.run')"
                :busy="vm.mutation.busy.value"
                @action="action(agent, $event)"
              />
            </footer>
          </article>
          <ResourceStatus
            :loading="vm.resource.loading.value"
            :empty="
              !vm.resource.error.value && !vm.resource.data.value?.items.length
            "
            empty-title="暂无智能体"
            empty-description="创建一个智能体，关联所需的知识、技能与工具。"
          /> </template
      ></DataTable>
      <template #pagination>
        <ManagementPagination
          v-model:current-page="vm.page.value"
          v-model:page-size="vm.pageSize.value"
          :total="vm.resource.data.value?.total ?? 0"
          :page-sizes="[10, 20, 50]"
        />
      </template>
    </ManagementList>

    <ManagementDialog
      :model-value="Boolean(vm.editing.value)"
      :title="vm.editing.value === 'new' ? '新增智能体' : '编辑智能体'"
      class="agent-definition-dialog"
      width="min(960px, calc(100vw - 32px))"
      :busy="vm.mutation.busy.value"
      :dirty="vm.dirty.value"
      :error="vm.mutation.error.value"
      :submit-disabled="
        vm.catalog.loading.value ||
        Boolean(vm.catalog.error.value) ||
        !vm.catalog.data.value
      "
      @update:model-value="vm.editing.value = null"
      @submit="save"
    >
      <ResourceStatus
        :loading="vm.catalog.loading.value"
        :error="vm.catalog.error.value"
        @retry="vm.catalog.reload"
      />
      <AgentEditor
        v-if="vm.editing.value"
        ref="editor"
        :draft="vm.draft"
        :catalog="vm.catalog.data.value"
        :busy="vm.mutation.busy.value"
        :issue="issue"
        :disabled="
          vm.catalog.loading.value ||
          Boolean(vm.catalog.error.value) ||
          vm.mutation.busy.value
        "
        @update:draft="updateDraft"
      />
    </ManagementDialog>
    <el-dialog
      :model-value="Boolean(vm.readiness.value)"
      title="智能体发布检查"
      width="min(720px, 94vw)"
      @update:model-value="vm.readiness.value = null"
      ><el-alert
        :type="vm.readiness.value?.result.ready ? 'success' : 'error'"
        :title="
          vm.readiness.value?.result.ready ? '配置检查通过' : '配置需要修复'
        "
        :closable="false"
      />
      <ul class="checks">
        <li
          v-for="check in vm.readiness.value?.result.checks ?? []"
          :key="check.id"
        >
          <el-tag
            :type="
              check.status === 'error'
                ? 'danger'
                : check.status === 'warning'
                  ? 'warning'
                  : 'success'
            "
            >{{
              check.status === 'pass'
                ? '通过'
                : check.status === 'error'
                  ? '错误'
                  : '提示'
            }}</el-tag
          >
          {{ check.message }}
        </li>
      </ul></el-dialog
    >
    <el-dialog
      :model-value="Boolean(vm.deleting.value)"
      title="删除智能体"
      width="min(480px, 94vw)"
      :close-on-click-modal="false"
      @update:model-value="vm.deleting.value = null"
      ><p>
        删除 {{ vm.deleting.value?.name }}？已有会话将不能继续调用其绑定工具。
      </p>
      <template #footer
        ><el-button
          :disabled="vm.mutation.busy.value"
          @click="vm.deleting.value = null"
          >取消</el-button
        ><el-button
          type="danger"
          :loading="vm.mutation.busy.value"
          @click="vm.remove"
          >确认删除</el-button
        ></template
      ></el-dialog
    >
  </section>
</template>

<style scoped>
.checks {
  padding-left: 0;
  list-style: none;
}
.checks li {
  padding: 8px 0;
}
</style>
