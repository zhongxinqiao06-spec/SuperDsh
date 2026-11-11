<script setup lang="ts">
import ManagementList from '@/components/management/ManagementList.vue'
import RowActions from '@/components/management/RowActions.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import DateTime from '@/components/base/DateTime.vue'
import { useTools, implementationKey } from '@/composables/tools/use-tools'
import { usePreferences } from '@/store/modules/preferences'
import { schemaObject } from '@/utils/tools/schema'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import SchemaField from '@/views/tools/components/SchemaField.vue'
import ToolSourcesDialog from '@/views/tools/components/ToolSourcesDialog.vue'
import ResourceHistoryDialog from '@/components/overlay/ResourceHistoryDialog.vue'
const vm = useTools(),
  { tr } = usePreferences()
</script>
<template>
  <section class="page paged-page management-page resource-management-page">
    <PageHeader :title="tr('工具管理', 'Tool management')" />
    <FilterBar class="toolbar" @submit="vm.filter">
      <el-input
        v-model="vm.query.value"
        clearable
        :placeholder="tr('搜索名称或描述', 'Search name or description')"
      /><el-button native-type="submit">{{ tr('搜索', 'Search') }}</el-button>
      <el-button
        v-if="vm.auth.can('extensions.manage')"
        @click="vm.sourcesOpen.value = true"
        >{{ tr('扩展来源与 MCP', 'Extensions and MCP') }}</el-button
      >
      <el-button type="primary" @click="vm.edit('new')">{{
        tr('新增工具', 'New tool')
      }}</el-button>
    </FilterBar>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :has-data="Boolean(vm.resource.data.value)"
      :error="vm.resource.error.value || vm.sources.error.value"
      @retry="vm.refreshed"
    /><ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <el-table
        :data="vm.resource.data.value?.items ?? []"
        :empty-text="
          vm.resource.error.value
            ? '工具加载失败，请重试。'
            : vm.resource.loading.value
              ? '正在加载工具…'
              : vm.query.value
                ? '没有匹配的工具。'
                : '暂无工具。'
        "
        ><el-table-column
          prop="name"
          :label="tr('名称与用途', 'Name and purpose')"
          min-width="180"
          ><template #default="{ row }"
            ><strong>{{ row.name }}</strong
            ><small class="resource-table-note">{{
              row.description
            }}</small></template
          ></el-table-column
        ><el-table-column :label="tr('状态', 'Status')"
          ><template #default="{ row }"
            ><el-tag>{{
              row.enabled ? tr('启用', 'Enabled') : tr('停用', 'Disabled')
            }}</el-tag></template
          ></el-table-column
        ><el-table-column :label="tr('配置', 'Configuration')"
          ><template #default="{ row }"
            >{{ row.implementation?.sourceId }} / {{ row.implementation?.toolId
            }}<small class="resource-table-note"
              >{{ row.implementation?.version }} · 版本 {{ row.version }}</small
            ></template
          ></el-table-column
        ><el-table-column :label="tr('最近更新', 'Updated')"
          ><template #default="{ row }"
            ><DateTime :value="row.updatedAt" /></template></el-table-column
        ><el-table-column :label="tr('操作', 'Actions')" min-width="168"
          ><template #default="{ row }"
            ><RowActions :busy="vm.mutation.busy.value">
              <el-button link @click="vm.edit(row)">{{
                tr('编辑', 'Edit')
              }}</el-button>
              <el-button link @click="vm.history.value = row">{{
                tr('历史', 'History')
              }}</el-button>
              <el-button
                link
                class="danger-action"
                @click="vm.deleting.value = row"
                >{{ tr('删除', 'Delete') }}</el-button
              >
            </RowActions></template
          ></el-table-column
        ></el-table
      >
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
      :model-value="vm.editing.value !== null"
      :title="
        vm.editing.value === 'new'
          ? tr('新增工具', 'New tool')
          : tr('编辑工具配置', 'Edit tool configuration')
      "
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editing.value = null"
      @submit="vm.save"
      ><label class="field"
        >{{ tr('名称', 'Name')
        }}<el-input v-model="vm.draft.name" maxlength="100" /></label
      ><label class="field"
        >{{ tr('说明', 'Description')
        }}<el-input
          v-model="vm.draft.description"
          type="textarea"
          maxlength="1000" /></label
      ><el-switch
        v-model="vm.draft.enabled"
        :active-text="tr('启用配置', 'Enable configuration')" /><label
        class="field"
        >{{ tr('工具实现与版本', 'Tool implementation and version')
        }}<el-select
          :model-value="implementationKey(vm.draft.implementation)"
          filterable
          @update:model-value="vm.choose"
          ><el-option
            v-if="vm.draft.implementation.sourceId && !vm.selected.value"
            :value="implementationKey(vm.draft.implementation)"
            :label="`${vm.draft.implementation.toolId} · ${tr('已绑定版本', 'Pinned version')} ${vm.draft.implementation.version}`" /><el-option
            v-for="choice in vm.choices.value"
            :key="implementationKey(choice.implementation)"
            :value="implementationKey(choice.implementation)"
            :label="choice.label" /></el-select></label
      ><template v-if="vm.descriptor.value"
        ><p>{{ vm.descriptor.value.description }}</p>
        <p class="muted">
          {{ tr('所需权限', 'Required permissions') }}：{{
            vm.descriptor.value.permissions.join(', ')
          }}
          · {{ tr('超时秒数', 'Timeout seconds') }}：{{
            vm.descriptor.value.timeoutSeconds
          }}
        </p>
        <label
          v-if="vm.descriptor.value.configurationPresets?.length"
          class="field"
          >{{ tr('从预设复制配置', 'Copy a configuration preset')
          }}<el-select :model-value="''" @update:model-value="vm.preset"
            ><el-option
              v-for="preset in vm.descriptor.value.configurationPresets"
              :key="preset.id"
              :value="preset.id"
              :label="`${preset.name} · ${preset.version}`" /></el-select></label
        ><SchemaField
          :schema="vm.descriptor.value.configurationSchema"
          :root="vm.descriptor.value.configurationSchema"
          :model-value="vm.draft.settings"
          path=""
          :configured-secrets="
            vm.editing.value && vm.editing.value !== 'new'
              ? vm.editing.value.configuredSecrets
              : []
          "
          :capabilities="vm.capabilities.data.value?.configurations ?? []"
          @update:model-value="
            vm.draft.settings = schemaObject($event)
          " /></template
    ></ManagementDialog>
    <ManagementDialog
      :model-value="vm.deleting.value !== null"
      :title="tr('删除工具配置', 'Delete tool configuration')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.deleting.value = null"
      @submit="vm.remove"
      ><p>
        {{
          tr(
            '仍被技能或智能体引用的配置不能删除。',
            'Configurations referenced by skills or agents cannot be deleted.',
          )
        }}
        {{ vm.deleting.value?.name }}
      </p></ManagementDialog
    >
    <ToolSourcesDialog
      v-if="vm.sourcesOpen.value"
      v-model="vm.sourcesOpen.value"
      @changed="vm.refreshed"
    /><ResourceHistoryDialog
      v-if="vm.history.value"
      :resource="vm.history.value"
      kind="tools"
      @close="vm.history.value = null"
      @changed="vm.resource.reload"
    />
  </section>
</template>
