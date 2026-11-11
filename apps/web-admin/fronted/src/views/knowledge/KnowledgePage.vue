<script setup lang="ts">
import ManagementList from '@/components/management/ManagementList.vue'
import RowActions from '@/components/management/RowActions.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import DataTable from '@/components/management/DataTable.vue'
import { computed } from 'vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { dateTimeLabel } from '@/utils/date-time'
import { useKnowledge } from '@/composables/knowledge/use-knowledge'
import { useKnowledgeFiles } from '@/composables/knowledge/use-knowledge-files'
import { sourceLocation } from '@/utils/knowledge/knowledge-drafts'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ResourceChoices from '@/components/form/ResourceChoices.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import AssetLibrary from '@/views/agents/components/AssetLibrary.vue'
import EmbeddingEditor from '@/views/knowledge/components/EmbeddingEditor.vue'
/** 知识库管理、索引状态与来源检索测试分区展示，失败资料可单独重试。 */
const vm = useKnowledge()
const files = useKnowledgeFiles(vm.reload)
const assetChoices = computed(() =>
  (vm.catalog.data.value?.assets ?? []).map((asset) => ({
    ...asset,
    description: {
      knowledge: '知识资料',
      'spreadsheet-template': 'Excel 模板',
      'document-template': 'Word 模板',
      'presentation-template': 'PPT 模板',
    }[asset.kind],
  })),
)
const states = {
  pending: '待索引',
  indexing: '索引中',
  ready: '已就绪',
  failed: '失败',
}
</script>

<template>
  <section class="page paged-page management-page resource-management-page">
    <PageHeader title="知识库" />
    <el-alert
      v-if="!vm.allowed.value"
      type="warning"
      title="当前账号没有知识库管理权限"
      :closable="false"
    />
    <FilterBar class="toolbar" @submit="vm.filter">
      <el-input
        v-model="vm.query.value"
        placeholder="搜索知识库"
        aria-label="搜索知识库"
        clearable
      /><el-button native-type="submit">搜索</el-button
      ><el-button v-if="vm.allowed.value" type="primary" @click="vm.edit('new')"
        >新增知识库</el-button
      >
      <el-button
        v-if="vm.health.data.value"
        :loading="vm.health.loading.value"
        @click="vm.health.reload"
        >检查连接</el-button
      >
      <el-button
        v-if="vm.health.data.value && vm.auth.can('models.manage')"
        @click="vm.showEmbedding"
        >检索设置</el-button
      ></FilterBar
    >
    <div v-if="vm.health.data.value" class="resource-health">
      <span
        :class="['status-dot', { ready: vm.health.data.value.ready }]"
      /><strong>Qdrant</strong><span>{{ vm.health.data.value.message }}</span>
    </div>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :has-data="Boolean(vm.resource.data.value)"
      :error="
        vm.resource.error.value ||
        vm.catalog.error.value ||
        vm.health.error.value
      "
      @retry="vm.reload"
    />

    <el-alert
      v-if="vm.mutation.error.value"
      type="error"
      :title="vm.mutation.error.value"
      :closable="false"
    />
    <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <DataTable mobile-cards label="数据列表" table-class="agents-table">
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
            v-for="base in vm.resource.data.value?.items ?? []"
            :key="base.id"
          >
            <td>
              <strong>{{ base.name }}</strong
              ><small>{{ base.description }}</small>
            </td>
            <td data-label="状态">
              <el-tag :type="base.enabled ? 'success' : 'info'">{{
                base.enabled ? '启用' : '停用'
              }}</el-tag>
            </td>
            <td data-label="配置">
              {{ base.assetIds.length }} 份资料 / 模板<small
                >版本 {{ base.version }}</small
              >
            </td>
            <td data-label="最近更新">{{ dateTimeLabel(base.updatedAt) }}</td>
            <td>
              <RowActions
                :busy="vm.mutation.busy.value || vm.indexMutation.busy.value"
              >
                <el-button link @click="vm.edit(base)">编辑</el-button>
                <el-button text size="small" @click="files.open(base)"
                  >管理文件</el-button
                >
                <el-button
                  link
                  :disabled="!base.enabled"
                  @click="vm.selected.value = base"
                  >索引 / 检索</el-button
                >
                <el-button link @click="vm.showHistory(base)">版本</el-button>
                <el-button
                  link
                  class="danger-action"
                  @click="vm.deleting.value = base"
                  >删除</el-button
                >
              </RowActions>
            </td>
          </tr>
          <tr
            v-if="
              !vm.resource.loading.value &&
              !vm.resource.error.value &&
              !vm.resource.data.value?.items.length
            "
          >
            <td colspan="5" class="empty-cell">暂无知识库。</td>
          </tr>
        </tbody>
      </DataTable>
      <section v-if="vm.selected.value" class="knowledge-panel">
        <div class="page-heading">
          <div>
            <h2>{{ vm.selected.value.name }} · 检索测试</h2>
            <p>索引失败后先刷新状态，再按需重试具体资料。</p>
          </div>
          <div class="toolbar">
            <el-button @click="vm.documents.reload">刷新状态</el-button
            ><el-button
              :loading="vm.indexMutation.busy.value"
              :disabled="
                !vm.selected.value.assetIds.length ||
                vm.documents.data.value?.items.some(
                  (item) => item.state === 'indexing',
                )
              "
              @click="vm.index()"
              >重建全部索引</el-button
            ><el-button @click="vm.selected.value = null">关闭</el-button>
          </div>
        </div>
        <ResourceStatus
          :loading="vm.documents.loading.value"
          :error="vm.documents.error.value"
          @retry="vm.documents.reload"
        /><el-alert
          v-if="vm.indexMutation.error.value"
          type="error"
          :title="vm.indexMutation.error.value"
          :closable="false"
        />
        <DataTable mobile-cards label="数据列表">
          <thead>
            <tr>
              <th>资料</th>
              <th>索引状态</th>
              <th>片段数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="document in vm.documents.data.value?.items ?? []"
              :key="document.assetId"
            >
              <td>
                {{ document.filename
                }}<small>代际 {{ document.generation.slice(0, 12) }}</small>
              </td>
              <td data-label="索引状态">
                {{ states[document.state]
                }}<small v-if="document.message">{{ document.message }}</small>
              </td>
              <td data-label="片段数">{{ document.chunks }}</td>
              <td data-label="操作">
                <el-button
                  link
                  :disabled="
                    vm.indexMutation.busy.value || document.state === 'indexing'
                  "
                  @click="vm.index(document.assetId)"
                  >{{
                    document.state === 'failed' ? '重试' : '重建'
                  }}</el-button
                >
              </td>
            </tr>
          </tbody>
        </DataTable>
        <FilterBar class="toolbar" @submit="vm.testSearch">
          <el-input
            v-model="vm.question.value"
            maxlength="200"
            placeholder="输入与资料相关的问题，检查原文来源"
            aria-label="检索问题"
          /><el-button
            type="primary"
            native-type="submit"
            :loading="vm.indexMutation.busy.value"
            :disabled="!vm.question.value.trim()"
            >检索</el-button
          >
        </FilterBar>
        <el-empty
          v-if="vm.searched.value && !vm.sources.value.length"
          description="没有找到符合当前资料的来源，请调整问题或检查索引状态"
        />
        <article
          v-for="source in vm.sources.value"
          :key="source.sourceId"
          class="source-card"
        >
          <h3>{{ source.filename }}</h3>
          <p class="muted">{{ sourceLocation(source) }}</p>
          <blockquote>{{ source.content }}</blockquote>
          <details>
            <summary>出处标识</summary>
            <p>{{ source.sourceId }}</p>
            <p>SHA-256：{{ source.sha256 }}</p>
          </details>
        </article>
      </section>
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
      :title="vm.editing.value === 'new' ? '新增知识库' : '编辑知识库'"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      :submit-disabled="
        vm.catalog.loading.value || Boolean(vm.catalog.error.value)
      "
      @update:model-value="vm.editing.value = null"
      @submit="vm.save"
    >
      <div class="stack">
        <label class="field"
          >名称<el-input
            v-model="vm.draft.name"
            maxlength="80"
            :disabled="vm.mutation.busy.value"
        /></label>
        <label class="field"
          >用途说明<el-input
            v-model="vm.draft.description"
            type="textarea"
            :rows="3"
            maxlength="500"
            :disabled="vm.mutation.busy.value"
        /></label>
        <ResourceChoices
          title="资料与模板"
          :items="assetChoices"
          :selected="vm.draft.assetIds"
          :disabled="
            vm.catalog.loading.value ||
            Boolean(vm.catalog.error.value) ||
            vm.mutation.busy.value
          "
          empty="暂无资料，保存知识库后点击“管理文件”上传。"
          @change="vm.draft.assetIds = $event"
        />
        <el-checkbox
          v-model="vm.draft.enabled"
          :disabled="vm.mutation.busy.value"
          >启用知识库</el-checkbox
        >
      </div>
    </ManagementDialog>
    <el-dialog
      :model-value="Boolean(files.target.value)"
      :title="'管理文件 · ' + (files.target.value?.name ?? '')"
      width="min(1024px, 94vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="
        !files.assets.mutation.busy.value &&
        !files.mutation.busy.value &&
        !files.indexing.busy.value
      "
      @update:model-value="files.close"
    >
      <p class="muted">
        上传的资料将自动加入当前知识库；移出只解除关联，原文件和已有会话不受影响。
      </p>
      <div class="toolbar">
        <span class="toolbar-spacer" /><el-button
          :loading="files.indexing.busy.value"
          :disabled="
            files.mutation.busy.value || files.assets.mutation.busy.value
          "
          @click="files.reindex"
          >重建索引</el-button
        >
      </div>
      <ResourceStatus
        :loading="vm.catalog.loading.value"
        :error="
          files.mutation.error.value ||
          files.indexing.error.value ||
          vm.catalog.error.value
        "
        @retry="vm.catalog.reload"
      />
      <p v-if="files.notice.value" role="status" class="muted">
        {{ files.notice.value }}
      </p>
      <AssetLibrary
        v-if="files.target.value"
        :assets="
          (vm.catalog.data.value?.assets ?? []).filter((asset) =>
            files.target.value?.assetIds.includes(asset.id),
          )
        "
        :busy="
          files.assets.mutation.busy.value ||
          files.mutation.busy.value ||
          files.indexing.busy.value ||
          vm.catalog.loading.value
        "
        :error="files.assets.mutation.error.value"
        :uploading="files.assets.uploading.value"
        :kind="files.assets.kind.value"
        :filename="files.assets.file.value?.name ?? ''"
        :name="files.assets.name.value"
        :preview="files.assets.preview.value"
        :preview-url="files.assets.previewUrl.value"
        removable
        @update:uploading="files.assets.uploading.value = $event"
        @update:kind="files.assets.kind.value = $event"
        @update:name="files.assets.name.value = $event"
        @choose="files.assets.choose"
        @upload="files.assets.upload"
        @preview="files.assets.showPreview"
        @download="files.assets.download"
        @remove="files.remove"
        @close-preview="files.assets.clearPreview"
      />
    </el-dialog>
    <ManagementDialog
      :model-value="vm.embeddingOpen.value"
      title="知识语义模型设置"
      :busy="vm.embeddingMutation.busy.value"
      :error="vm.embeddingMutation.error.value"
      @update:model-value="vm.embeddingOpen.value = false"
      @submit="vm.saveEmbedding"
      ><EmbeddingEditor
        :draft="vm.embedding"
        :settings="vm.profile.data.value"
        :busy="vm.embeddingMutation.busy.value"
        @update:draft="vm.updateEmbedding"
        @prepare="vm.prepareLocal"
    /></ManagementDialog>
    <el-dialog
      :model-value="Boolean(vm.historyTarget.value)"
      :title="(vm.historyTarget.value?.name ?? '') + ' · 配置历史'"
      width="min(720px, 94vw)"
      @update:model-value="vm.historyTarget.value = null"
      ><ResourceStatus
        :loading="vm.history.loading.value"
        :error="vm.history.error.value"
        @retry="vm.history.reload" />
      <ul class="history-list">
        <li
          v-for="version in vm.history.data.value?.items ?? []"
          :key="version.version"
        >
          <div>
            <strong>版本 {{ version.version }} · {{ version.name }}</strong>
            <p>{{ version.description }}</p>
            <small
              >{{ version.assetIds.length }} 份资料 ·
              {{ version.updatedAt }}</small
            >
          </div>
          <el-button
            :disabled="
              version.version === vm.history.data.value?.currentVersion
            "
            @click="vm.restoring.value = version"
            >恢复此版本</el-button
          >
        </li>
      </ul>
      <ManagementPagination
        v-model:current-page="vm.historyPage.value"
        v-model:page-size="vm.historySize.value"
        :total="vm.history.data.value?.total ?? 0"
        :page-sizes="[10, 20, 50]"
    /></el-dialog>
    <el-dialog
      :model-value="Boolean(vm.restoring.value)"
      title="确认恢复配置"
      width="min(480px, 94vw)"
      @update:model-value="vm.restoring.value = null"
      ><p>
        恢复版本
        {{ vm.restoring.value?.version }}
        的资料绑定和配置？将新增一个版本，保留全部历史。
      </p>
      <el-alert
        v-if="vm.mutation.error.value"
        type="error"
        :title="vm.mutation.error.value"
        :closable="false"
      /><template #footer
        ><el-button
          :disabled="vm.mutation.busy.value"
          @click="vm.restoring.value = null"
          >取消</el-button
        ><el-button
          type="primary"
          :loading="vm.mutation.busy.value"
          @click="vm.restore"
          >确认恢复</el-button
        ></template
      ></el-dialog
    >
    <el-dialog
      :model-value="Boolean(vm.deleting.value)"
      title="删除知识库"
      width="min(480px, 94vw)"
      @update:model-value="vm.deleting.value = null"
      ><p>
        删除
        {{ vm.deleting.value?.name }}？绑定此知识库的会话将不能继续检索其资料。
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
.knowledge-panel {
  border: 1px solid var(--el-border-color);
  padding: 16px;
  margin-block: 0;
  border-radius: 14px;
}
.source-card {
  padding: 18px;
  margin-block: 12px;
  background: var(--el-fill-color-light);
  border-radius: 10px;
  overflow-wrap: anywhere;
}
blockquote {
  margin: 12px 0;
  white-space: pre-wrap;
  border-left: 3px solid var(--el-color-primary);
  padding-left: 14px;
}
small,
.muted {
  display: block;
  color: var(--el-text-color-secondary);
}
.history-list {
  list-style: none;
  padding: 0;
}
.history-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
  border-bottom: 1px solid var(--el-border-color);
}
</style>
