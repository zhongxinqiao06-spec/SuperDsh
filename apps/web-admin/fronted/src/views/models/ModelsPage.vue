<script setup lang="ts">
import ManagementList from '@/components/management/ManagementList.vue'
import RowActions from '@/components/management/RowActions.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import DataTable from '@/components/management/DataTable.vue'
import { ref } from 'vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useModels } from '@/composables/models/use-models'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ProviderEditor from '@/views/models/components/ProviderEditor.vue'
import ConnectionEditor from '@/views/models/components/ConnectionEditor.vue'
import ConfigurationEditor from '@/views/models/components/ConfigurationEditor.vue'
import PersonalProviderCard from '@/views/models/components/PersonalProviderCard.vue'
/** 聊天、多模态和个人模型共用协议组件，作用域权限由页面用例固定。 */
const vm = useModels()
const connectionsOpen = ref(false)
</script>

<template>
  <section
    class="page paged-page management-page models-page"
    :class="{ 'personal-models-page': vm.personal.value }"
  >
    <PageHeader
      :title="
        vm.personal.value
          ? '个人模型'
          : vm.multimodal.value
            ? '多模态模型'
            : '聊天模型'
      "
    />
    <el-alert
      v-if="!vm.allowed.value"
      type="warning"
      title="当前账号没有此页面的管理权限"
      :closable="false"
    />
    <ResourceStatus
      :loading="
        vm.catalog.loading.value ||
        vm.providers.loading.value ||
        vm.selected.loading.value
      "
      :error="
        vm.catalog.error.value ||
        vm.providers.error.value ||
        vm.selected.error.value
      "
      @retry="vm.reload"
    />
    <el-alert
      v-if="vm.mutation.error.value"
      type="error"
      :title="vm.mutation.error.value"
      :closable="false"
    />
    <el-alert
      v-if="vm.verificationNotice.value"
      :type="vm.verificationNotice.value.type"
      :title="vm.verificationNotice.value.message"
      :closable="false"
    />
    <template v-if="vm.personal.value && vm.allowed.value">
      <FilterBar class="toolbar">
        <el-input
          v-model="vm.providerQuery.value"
          clearable
          aria-label="搜索供应商或模型"
          placeholder="搜索供应商或模型"
        />
        <el-button
          type="primary"
          :disabled="
            vm.providers.loading.value ||
            vm.selected.loading.value ||
            vm.mutation.busy.value ||
            Boolean(vm.providers.error.value || vm.selected.error.value)
          "
          @click="vm.editProvider('new')"
          >添加供应商</el-button
        >
        <el-button
          v-if="vm.selected.data.value?.selection"
          :disabled="vm.mutation.busy.value"
          @click="vm.clearPersonalDefault.value = true"
          >使用平台默认模型</el-button
        >
        <span class="personal-default-label"
          >个人默认模型：{{ vm.personalDefaultLabel.value }}</span
        >
      </FilterBar>
      <ManagementList
        :page="vm.providerPage.value"
        :page-size="vm.providerPageSize.value"
      >
        <p
          v-if="
            !vm.providers.loading.value &&
            !vm.providers.data.value?.providers.length
          "
          class="personal-model-empty"
        >
          添加个人供应商和模型，即可在服务端 Agent 中使用，无需连接电脑。
        </p>
        <p
          v-else-if="
            !vm.providers.loading.value && !vm.filteredProviders.value.length
          "
          class="personal-model-empty"
        >
          没有匹配的供应商或模型。
        </p>
        <PersonalProviderCard
          v-for="provider in vm.providerRows.value"
          :key="provider.providerId"
          :provider="provider"
          :busy="vm.mutation.busy.value"
          :selected-model-id="
            vm.selected.data.value?.selection?.providerId ===
            provider.providerId
              ? vm.selected.data.value.selection.modelId
              : null
          "
          @edit="vm.editProvider(provider)"
          @verify="vm.verify(provider.providerId)"
          @remove="vm.deleting.value = provider"
          @select="
            vm.selectModel({ providerId: provider.providerId, modelId: $event })
          "
        />
        <template #pagination>
          <ManagementPagination
            v-model:current-page="vm.providerPage.value"
            v-model:page-size="vm.providerPageSize.value"
            :total="vm.filteredProviders.value.length"
            :page-sizes="[10, 20, 50]"
            :loading="vm.providers.loading.value || vm.mutation.busy.value"
          />
        </template>
      </ManagementList>

      <el-dialog
        v-model="vm.clearPersonalDefault.value"
        title="使用平台默认模型"
        class="management-dialog"
        width="min(480px, 94vw)"
        :close-on-click-modal="false"
        :close-on-press-escape="!vm.mutation.busy.value"
        :show-close="!vm.mutation.busy.value"
      >
        <p>新会话将使用平台默认模型，已有会话的选择保持不变。</p>
        <el-alert
          v-if="vm.mutation.error.value"
          type="error"
          :title="vm.mutation.error.value"
          :closable="false"
        />
        <template #footer
          ><el-button
            :disabled="vm.mutation.busy.value"
            @click="vm.clearPersonalDefault.value = false"
            >取消</el-button
          ><el-button
            type="primary"
            :loading="vm.mutation.busy.value"
            @click="vm.selectModel(null)"
            >确认</el-button
          ></template
        >
      </el-dialog>
    </template>
    <template v-else-if="!vm.personal.value">
      <FilterBar class="toolbar models-search">
        <el-input
          v-model="vm.query.value"
          clearable
          aria-label="搜索模型配置"
          placeholder="搜索配置名称或模型 ID"
        />
        <el-button
          v-if="vm.allowed.value"
          type="primary"
          @click="vm.editConfiguration('new')"
          >新增配置</el-button
        >

        <el-button
          v-if="!vm.personal.value && vm.allowed.value"
          @click="connectionsOpen = true"
          >供应商连接</el-button
        >
      </FilterBar>
      <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
        <DataTable mobile-cards label="数据列表">
          <thead>
            <tr>
              <th>配置 / 供应商</th>
              <th>能力 / 模型</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="config in vm.configurationRows.value" :key="config.id">
              <td>
                <strong>{{ config.name }}</strong
                ><small
                  >{{
                    vm.catalog.data.value?.connections.find(
                      (item) => item.id === config.connectionId,
                    )?.name
                  }}
                  · 修订 {{ config.revision }}</small
                >
              </td>
              <td data-label="能力 / 模型">
                {{
                  vm.catalog.data.value?.capabilities.find(
                    (item) => item.id === config.capability,
                  )?.name || config.capability
                }}<small>{{ config.modelId }}</small>
              </td>
              <td data-label="状态">
                <el-tag :type="config.enabled ? 'success' : 'info'">{{
                  config.enabled ? '启用' : '停用'
                }}</el-tag
                ><small
                  v-if="
                    vm.catalog.data.value?.defaults.some(
                      (item) => item.configurationId === config.id,
                    )
                  "
                  >默认配置</small
                >
              </td>
              <td>
                <RowActions :busy="vm.mutation.busy.value">
                  <el-button link @click="vm.editConfiguration(config)"
                    >编辑</el-button
                  >
                  <el-button
                    link
                    :disabled="vm.mutation.busy.value"
                    @click="vm.verify(config.id)"
                    >只读检测</el-button
                  >
                  <el-button
                    v-if="
                      vm.catalog.data.value?.defaults.some(
                        (item) => item.configurationId === config.id,
                      )
                    "
                    link
                    @click="vm.setDefault(config, true)"
                    >清除默认</el-button
                  >
                  <el-button
                    v-else
                    link
                    :disabled="!config.enabled"
                    @click="vm.setDefault(config)"
                    >设为默认</el-button
                  >
                </RowActions>
              </td>
            </tr>
            <tr v-if="vm.configurationEmptyMessage.value">
              <td colspan="4" class="empty-cell">
                {{ vm.configurationEmptyMessage.value }}
              </td>
            </tr>
          </tbody>
        </DataTable>
        <template #pagination>
          <ManagementPagination
            v-model:current-page="vm.page.value"
            v-model:page-size="vm.pageSize.value"
            :total="vm.configurations.value.length"
            :page-sizes="[10, 20, 50]"
          />
        </template>
      </ManagementList>

      <el-dialog
        v-model="connectionsOpen"
        title="供应商连接"
        width="min(800px,94vw)"
        class="management-dialog"
      >
        <div class="connection-panel">
          <div class="toolbar connection-actions">
            <el-button @click="vm.reload">刷新</el-button
            ><el-button type="primary" @click="vm.editConnection('new')"
              >新增连接</el-button
            >
          </div>
          <div class="connection-grid">
            <article
              v-for="connection in vm.catalog.data.value?.connections ?? []"
              :key="connection.id"
              class="model-card"
            >
              <h3>{{ connection.name }}</h3>
              <p>
                {{ connection.adapter }} ·
                {{ connection.enabled ? '启用' : '停用' }}
              </p>
              <p>
                {{
                  connection.credentialConfigured ? '密钥已配置' : '未配置密钥'
                }}
              </p>
              <el-button @click="vm.editConnection(connection)"
                >编辑连接</el-button
              >
            </article>
          </div>
        </div>
      </el-dialog>
    </template>
    <ManagementDialog
      :model-value="Boolean(vm.editingProvider.value)"
      width="min(896px, calc(100vw - 32px))"
      :title="vm.editingProvider.value === 'new' ? '添加供应商' : '编辑供应商'"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="!$event && vm.closeProvider()"
      @submit="vm.saveProvider"
      ><ProviderEditor
        v-model:make-default="vm.makePersonalDefault.value"
        v-model:page="vm.providerModelPage.value"
        v-model:page-size="vm.providerModelPageSize.value"
        :draft="vm.provider"
        :creating="vm.editingProvider.value === 'new'"
        :preset="vm.providerPreset.value"
        :key-configured="
          Boolean(
            vm.editingProvider.value &&
            vm.editingProvider.value !== 'new' &&
            vm.editingProvider.value.apiKeyConfigured,
          )
        "
        @update:preset="vm.changeProviderPreset"
        @update:draft="vm.updateProvider"
    /></ManagementDialog>
    <ManagementDialog
      :model-value="Boolean(vm.editingConnection.value)"
      title="供应商连接"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editingConnection.value = null"
      @submit="vm.saveConnection"
      ><ConnectionEditor
        :draft="vm.connection"
        :key-configured="
          Boolean(
            vm.editingConnection.value &&
            vm.editingConnection.value !== 'new' &&
            vm.editingConnection.value.credentialConfigured,
          )
        "
        @update:draft="vm.updateConnection"
    /></ManagementDialog>
    <ManagementDialog
      :model-value="Boolean(vm.editingConfiguration.value)"
      title="模型能力配置"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editingConfiguration.value = null"
      @submit="vm.saveConfiguration"
      ><ConfigurationEditor
        :draft="vm.configuration"
        :catalog="vm.catalog.data.value"
        :editing="vm.editingConfiguration.value !== 'new'"
        :multimodal="vm.multimodal.value"
        :roles="vm.roles.data.value?.roles ?? []"
        @update:draft="vm.updateConfiguration"
    /></ManagementDialog>
    <el-dialog
      :model-value="Boolean(vm.deleting.value)"
      title="删除供应商"
      width="min(480px, 94vw)"
      :close-on-click-modal="false"
      @update:model-value="vm.deleting.value = null"
      ><p>删除 {{ vm.deleting.value?.name }}？相关默认选择会一并清除。</p>
      <template #footer
        ><el-button
          :disabled="vm.mutation.busy.value"
          @click="vm.deleting.value = null"
          >取消</el-button
        ><el-button
          type="danger"
          :loading="vm.mutation.busy.value"
          @click="vm.deleteProvider"
          >确认删除</el-button
        ></template
      ></el-dialog
    >
  </section>
</template>

<style scoped>
.personal-models-page {
  gap: 20px;
}
.personal-default-label {
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
.personal-model-empty {
  margin: 0;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 14px;
  color: var(--muted-foreground);
}
.connection-panel {
  display: grid;
  gap: 20px;
}
.connection-actions {
  gap: 8px;
}
/* 按钮间距统一交给容器，避免组件默认 margin 与 gap 叠加。 */
.connection-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.model-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 14px;
  padding: 20px;
  margin: 0;
  background: var(--el-bg-color);
  overflow-wrap: anywhere;
}
.model-card h3,
.model-card p {
  margin: 0;
}
.model-card h3 {
  font-size: 16px;
  line-height: 24px;
}
.model-card p {
  line-height: 20px;
}
.model-card > .el-button {
  margin-top: auto;
}
.connection-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 16px;
}
small {
  display: block;
  color: var(--el-text-color-secondary);
}
li {
  margin-block: 10px;
}
</style>
