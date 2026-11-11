<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import { useToolSources } from '@/composables/tools/use-tool-sources'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
const open = defineModel<boolean>({ required: true }),
  emit = defineEmits<{ changed: [] }>(),
  vm = useToolSources(() => emit('changed')),
  { tr } = usePreferences()
</script>
<template>
  <el-dialog
    v-model="open"
    :title="tr('工具来源管理', 'Tool source management')"
    width="min(1000px,96vw)"
    :close-on-click-modal="!vm.mutation.busy.value"
    ><ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    /><el-alert
      v-if="vm.mutation.error.value"
      :title="vm.mutation.error.value"
      type="error"
      :closable="false"
    /><el-alert
      v-if="vm.notice.value"
      :title="vm.notice.value"
      type="success"
    /><el-tabs v-model="vm.tab.value"
      ><el-tab-pane
        name="installed"
        :label="tr('已安装来源', 'Installed sources')"
        ><div class="toolbar">
          <el-button @click="vm.openPackage">{{
            tr('安装扩展包', 'Install extension package')
          }}</el-button
          ><el-button @click="vm.edit()">{{
            tr('连接 MCP', 'Connect MCP')
          }}</el-button>
        </div>
        <el-table :data="vm.resource.data.value ?? []"
          ><el-table-column
            prop="name"
            :label="tr('名称', 'Name')"
          /><el-table-column
            prop="kind"
            :label="tr('类型', 'Type')"
          /><el-table-column :label="tr('可用状态', 'Status')"
            ><template #default="{ row }"
              ><el-tag
                :type="
                  row.enabled && row.status === 'ready' ? 'success' : 'warning'
                "
                >{{
                  row.enabled ? row.status : tr('已停用', 'Disabled')
                }}</el-tag
              >
              <p v-if="row.diagnostic">{{ row.diagnostic }}</p></template
            ></el-table-column
          ><el-table-column :label="tr('版本', 'Version')"
            ><template #default="{ row }"
              ><el-select
                v-model="vm.versions[row.id]"
                :disabled="row.kind === 'builtin'"
                ><el-option
                  v-for="version in row.versions"
                  :key="version.version"
                  :value="version.version"
                  :label="version.version" /></el-select
              ><el-button
                v-if="vm.versions[row.id] !== row.activeVersion"
                link
                @click="
                  vm.confirmation.value = {
                    source: row,
                    enabled: row.enabled,
                    version: vm.versions[row.id] ?? row.activeVersion,
                  }
                "
                >{{ tr('切换版本', 'Switch version') }}</el-button
              ></template
            ></el-table-column
          ><el-table-column :label="tr('操作', 'Actions')" width="200"
            ><template #default="{ row }"
              ><RowActions
                v-if="row.kind !== 'builtin'"
                :busy="vm.mutation.busy.value"
              >
                <el-button
                  link
                  :disabled="vm.mutation.busy.value"
                  @click="vm.check(row)"
                  >{{ tr('健康检查', 'Health check') }}</el-button
                >
                <el-button link @click="vm.edit(row)">{{
                  tr('更新', 'Update')
                }}</el-button>
                <el-button
                  link
                  :type="row.enabled ? 'danger' : 'primary'"
                  @click="
                    vm.confirmation.value = {
                      source: row,
                      enabled: !row.enabled,
                      version: row.activeVersion,
                    }
                  "
                  >{{
                    row.enabled ? tr('停用', 'Disable') : tr('启用', 'Enable')
                  }}</el-button
                >
              </RowActions></template
            ></el-table-column
          ></el-table
        ></el-tab-pane
      >
      <el-tab-pane
        name="package"
        :label="tr('扩展包安装', 'Package installation')"
        ><form class="stack" @submit.prevent="vm.install">
          <p>
            {{
              tr(
                '安装包必须包含扩展清单和锁定依赖。只安装信任的可执行来源。',
                'Packages must include their manifest and locked dependencies. Install executable sources you trust.',
              )
            }}
          </p>
          <el-alert
            v-if="vm.target.value"
            :title="`${tr('更新来源', 'Updating source')}: ${vm.target.value.name}`"
            type="info"
            :closable="false"
          /><input
            type="file"
            accept=".zip,application/zip"
            :aria-label="tr('扩展ZIP包', 'Extension ZIP package')"
            :disabled="vm.mutation.busy.value"
            @change="vm.selectFile"
          /><el-button
            type="primary"
            native-type="submit"
            :loading="vm.mutation.busy.value"
            >{{ tr('安装并检查', 'Install and check') }}</el-button
          >
        </form></el-tab-pane
      >
      <el-tab-pane name="mcp" :label="tr('MCP 连接', 'MCP connection')"
        ><form class="stack" @submit.prevent="vm.connect">
          <label class="field"
            >{{ tr('来源标识', 'Source ID')
            }}<el-input
              v-model="vm.draft.id"
              :disabled="!!vm.target.value"
              maxlength="100" /></label
          ><label class="field"
            >{{ tr('名称', 'Name')
            }}<el-input v-model="vm.draft.name" maxlength="100" /></label
          ><label class="field"
            >{{ tr('发布版本', 'Release version')
            }}<el-input
              v-model="vm.draft.version"
              :placeholder="
                tr('填写该来源的新版本', 'Enter the source release version')
              " /></label
          ><label class="field"
            >{{ tr('HTTP 端点', 'HTTP endpoint')
            }}<el-input v-model="vm.draft.endpoint" type="url" /></label
          ><label class="field"
            >{{ tr('授权令牌', 'Authorization token')
            }}<el-input
              v-model="vm.draft.token"
              type="password"
              show-password
              autocomplete="new-password"
              :placeholder="
                vm.target.value?.credentialConfigured
                  ? tr(
                      '已配置；留空仅可沿用相同端点凭据',
                      'Configured; leave blank to reuse for the same endpoint',
                    )
                  : ''
              " /></label
          ><el-button :loading="vm.mutation.busy.value" @click="vm.discover">{{
            tr('发现工具', 'Discover tools')
          }}</el-button
          ><template v-if="vm.discovery.value"
            ><p>
              {{
                tr(
                  '仅选择要授权给平台的工具；发现不等于授权。',
                  'Select the tools to authorize. Discovery does not grant access.',
                )
              }}
            </p>
            <el-checkbox-group v-model="vm.draft.selectedToolIds"
              ><div
                v-for="tool in vm.discovery.value.tools"
                :key="tool.id"
                class="panel"
              >
                <el-checkbox :value="tool.id">{{ tool.name }}</el-checkbox>
                <p>{{ tool.description }}</p>
                <p class="muted">
                  {{ tr('权限', 'Permissions') }}：{{
                    tool.permissions.join(', ')
                  }}
                </p>
              </div></el-checkbox-group
            ><el-button
              type="primary"
              native-type="submit"
              :loading="vm.mutation.busy.value"
              :disabled="!vm.draft.selectedToolIds.length"
              >{{
                tr('确认授权并保存', 'Authorize selected tools and save')
              }}</el-button
            ></template
          >
        </form></el-tab-pane
      ></el-tabs
    >
    <ManagementDialog
      :model-value="vm.confirmation.value !== null"
      :title="tr('确认变更工具来源', 'Confirm source change')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.confirmation.value = null"
      @submit="vm.confirm"
      ><p>
        {{
          tr(
            '停用立即阻止后续调用；版本切换不会改写已有冻结绑定。',
            'Disabling blocks subsequent calls. Switching versions preserves existing pinned bindings.',
          )
        }}
      </p>
      <p>
        {{ vm.confirmation.value?.source.name }} ·
        {{ vm.confirmation.value?.version }} ·
        {{
          vm.confirmation.value?.enabled
            ? tr('启用', 'Enable')
            : tr('停用', 'Disable')
        }}
      </p></ManagementDialog
    >
  </el-dialog>
</template>
