<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import DataTable from '@/components/management/DataTable.vue'
import { useMenus } from '@/composables/console/use-menus'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
/** 菜单编辑仅改变显示配置；页面功能和授权来自产品注册目录。 */
const vm = useMenus()
const { tr } = usePreferences()
</script>

<template>
  <section class="page paged-page management-page">
    <PageHeader :title="tr('菜单管理', 'Navigation menus')" />
    <div v-if="vm.canEdit.value" class="toolbar toolbar-panel">
      <el-input
        v-model="vm.query.value"
        :placeholder="tr('搜索菜单名称或功能标识', 'Search navigation')"
        aria-label="搜索菜单"
        clearable
      />
      <el-button @click="vm.resource.reload">{{
        tr('刷新', 'Refresh')
      }}</el-button>
      <el-button type="primary" @click="vm.addGroup">
        {{ tr('新增分组', 'Add group') }} </el-button
      ><el-button @click="vm.resetOpen.value = true">
        {{ tr('恢复默认', 'Restore defaults') }} </el-button
      ><el-button v-if="vm.mutation.error.value" @click="vm.resource.reload">
        {{ tr('重新加载最新配置', 'Reload latest configuration') }}
      </el-button>
      <small
        >{{ tr('配置版本', 'Configuration revision') }}
        {{ vm.version.value }}</small
      >
    </div>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    /><el-alert
      v-if="vm.mutation.error.value"
      :title="vm.mutation.error.value"
      type="error"
      :closable="false"
      :description="
        tr(
          '保存失败，当前草稿已保留。发生冲突时请重新加载最新配置后编辑。',
          'Your draft is retained. Reload the latest configuration after a conflict.',
        )
      "
    />
    <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <DataTable mobile-cards label="数据列表">
        <thead>
          <tr>
            <th>{{ tr('名称', 'Name') }}</th>
            <th>{{ tr('类型 / 分组', 'Type / Group') }}</th>
            <th>{{ tr('显示状态', 'Visibility') }}</th>
            <th>{{ tr('角色范围', 'Role scope') }}</th>
            <th>{{ tr('排序', 'Order') }}</th>
            <th>{{ tr('操作', 'Actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in vm.rows.value" :key="item.id">
            <td><span v-if="item.parentId">↳ </span>{{ item.title }}</td>
            <td :data-label="tr('类型 / 分组', 'Type / Group')">
              {{
                item.kind === 'group'
                  ? tr('分组', 'Group')
                  : item.parentId
                    ? vm.items.value.find((group) => group.id === item.parentId)
                        ?.title
                    : tr('一级页面', 'Top-level page')
              }}
            </td>
            <td :data-label="tr('显示状态', 'Visibility')">
              {{ item.visible ? tr('显示', 'Visible') : tr('隐藏', 'Hidden') }}
            </td>
            <td :data-label="tr('角色范围', 'Role scope')">
              {{
                item.roleIds.length
                  ? item.roleIds
                      .map(
                        (id) =>
                          vm.resource.data.value?.roles?.find(
                            (role) => role.id === id,
                          )?.name ?? id,
                      )
                      .join(', ')
                  : tr('按功能权限', 'By feature permission')
              }}
            </td>
            <td :data-label="tr('排序', 'Order')">{{ item.order }}</td>
            <td>
              <RowActions :busy="vm.mutation.busy.value">
                <el-button v-if="vm.canEdit.value" link @click="vm.edit(item)">
                  {{ tr('编辑', 'Edit') }}
                </el-button>
                <el-button
                  v-if="vm.canEdit.value && item.kind === 'group'"
                  link
                  type="danger"
                  @click="vm.deletingGroup.value = item"
                  >{{ tr('删除分组', 'Delete group') }}</el-button
                >
              </RowActions>
            </td>
          </tr>
          <tr
            v-if="
              !vm.resource.loading.value &&
              !vm.resource.error.value &&
              !vm.rows.value.length
            "
          >
            <td colspan="6" class="empty-cell">
              {{ tr('没有匹配的菜单', 'No matching menu') }}
            </td>
          </tr>
        </tbody>
      </DataTable>
      <template #pagination>
        <ManagementPagination
          v-model:current-page="vm.page.value"
          v-model:page-size="vm.pageSize.value"
          :total="vm.filtered.value.length"
          :page-sizes="[10, 20, 50]"
        />
      </template>
    </ManagementList>

    <ManagementDialog
      :model-value="vm.editing.value !== null"
      :title="tr('编辑菜单项', 'Edit navigation item')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editing.value = null"
      @submit="vm.apply"
    >
      <template v-if="vm.editing.value">
        <label class="field"
          >{{ tr('名称', 'Name')
          }}<el-input v-model="vm.editing.value.title" maxlength="100" /></label
        ><label class="field"
          >{{ tr('图标', 'Icon')
          }}<el-select v-model="vm.editing.value.icon"
            ><el-option
              v-for="icon in vm.resource.data.value?.icons ?? []"
              :key="icon"
              :value="icon"
              :label="icon" /></el-select></label
        ><label v-if="vm.editing.value.kind === 'page'" class="field"
          >{{ tr('所属分组', 'Group')
          }}<el-select v-model="vm.editing.value.parentId" clearable
            ><el-option
              v-for="group in vm.items.value.filter(
                (item) => item.kind === 'group',
              )"
              :key="group.id"
              :value="group.id"
              :label="group.title" /></el-select></label
        ><label class="field"
          >{{ tr('排序', 'Order')
          }}<el-input-number
            v-model="vm.editing.value.order"
            :min="0"
            :max="10000" /></label
        ><label class="field"
          >{{ tr('角色范围（留空表示全部）', 'Roles (empty for all)')
          }}<el-select v-model="vm.editing.value.roleIds" multiple
            ><el-option
              v-for="role in vm.resource.data.value?.roles ?? []"
              :key="role.id"
              :value="role.id"
              :label="role.name" /></el-select></label
        ><el-checkbox v-model="vm.editing.value.visible">
          {{ tr('在导航中显示', 'Show in navigation') }}
        </el-checkbox>
        <small class="muted">{{
          tr(
            '显示设置只影响导航。访问权限由角色管理。',
            'Visibility affects navigation. Roles control access.',
          )
        }}</small>
      </template>
    </ManagementDialog>
    <el-dialog
      :model-value="vm.deletingGroup.value !== null"
      :title="tr('删除分组', 'Delete group')"
      width="min(440px,94vw)"
      @update:model-value="vm.deletingGroup.value = null"
    >
      <p>
        {{
          tr(
            '其中的页面会移到一级菜单，不会删除页面功能。',
            'Pages move to the top level. Features are retained.',
          )
        }}
      </p>
      <template #footer
        ><el-button @click="vm.deletingGroup.value = null">{{
          tr('取消', 'Cancel')
        }}</el-button
        ><el-button type="danger" @click="vm.removeGroup">{{
          tr('确认删除分组', 'Delete group')
        }}</el-button></template
      >
    </el-dialog>
    <el-dialog
      v-model="vm.resetOpen.value"
      :title="tr('恢复默认菜单', 'Restore default navigation')"
      width="min(440px,94vw)"
    >
      <p>
        {{
          tr(
            '确认覆盖当前菜单配置？尚未保存的修改将被丢弃。',
            'Replace the current navigation and discard unsaved edits?',
          )
        }}
      </p>
      <template #footer>
        <el-button @click="vm.resetOpen.value = false">
          {{ tr('取消', 'Cancel') }} </el-button
        ><el-button
          type="danger"
          :loading="vm.mutation.busy.value"
          @click="vm.reset"
        >
          {{ tr('确认恢复', 'Restore') }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>
