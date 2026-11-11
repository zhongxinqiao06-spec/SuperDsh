<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useRoles } from '@/composables/access/use-roles'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
/** 角色与权限编辑页，内置角色保护最终由服务端执行。 */
const vm = useRoles()
const { tr } = usePreferences()
</script>

<template>
  <section class="page paged-page management-page">
    <PageHeader :title="tr('角色与权限', 'Roles and permissions')" />
    <FilterBar>
      <el-input
        v-model="vm.search.value"
        :placeholder="tr('搜索角色', 'Search roles')"
        clearable
        @input="vm.page.value = 1"
      /><el-button type="primary" @click="vm.edit('new')">{{
        tr('创建角色', 'Create role')
      }}</el-button>
    </FilterBar>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    />
    <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <div class="role-grid">
        <article v-for="role in vm.rows.value" :key="role.id" class="role-card">
          <header>
            <h2>{{ role.name }}</h2>
            <small v-if="role.builtin">{{
              tr('内置 · 只读', 'Built-in · read-only')
            }}</small>
          </header>
          <p class="role-card-description">{{ role.description || '—' }}</p>
          <p>
            {{
              tr(
                `${role.permissions.length} 项权限`,
                `${role.permissions.length} permissions`,
              )
            }}
          </p>
          <RowActions :busy="vm.mutation.busy.value">
            <el-button link @click="vm.edit(role)">{{
              role.builtin
                ? tr('查看权限', 'View permissions')
                : tr('编辑', 'Edit')
            }}</el-button>
            <el-button
              v-if="!role.builtin"
              link
              type="danger"
              @click="vm.requestDelete(role)"
              >{{ tr('删除', 'Delete') }}</el-button
            >
          </RowActions>
        </article>
      </div>
      <el-empty
        v-if="
          !vm.resource.loading.value &&
          !vm.resource.error.value &&
          vm.rows.value.length === 0
        "
        :description="tr('没有符合条件的角色', 'No matching roles')"
      />
      <template #pagination>
        <ManagementPagination
          v-model:current-page="vm.page.value"
          v-model:page-size="vm.pageSize.value"
          :page-sizes="[10, 20, 50]"
          :total="vm.filtered.value.length"
        />
      </template>
    </ManagementList>

    <ManagementDialog
      :model-value="vm.editing.value !== null"
      :title="
        vm.editing.value === 'new'
          ? tr('新增角色', 'Add role')
          : vm.readonly.value
            ? tr('查看权限', 'View permissions')
            : tr('编辑角色', 'Edit role')
      "
      :busy="vm.mutation.busy.value"
      :readonly="vm.readonly.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editing.value = null"
      @submit="vm.save"
    >
      <label class="field"
        >{{ tr('角色名称', 'Role name')
        }}<el-input
          v-model="vm.draft.name"
          maxlength="100"
          :disabled="vm.readonly.value" /></label
      ><label class="field"
        >{{ tr('说明', 'Description')
        }}<el-input
          v-model="vm.draft.description"
          type="textarea"
          :rows="2"
          maxlength="1000"
          :disabled="vm.readonly.value"
      /></label>
      <fieldset class="permission-list">
        <legend>{{ tr('权限', 'Permissions') }}</legend>
        <el-checkbox-group
          v-model="vm.draft.permissions"
          :disabled="vm.readonly.value"
        >
          <el-checkbox
            v-for="permission in vm.resource.data.value?.permissions ?? []"
            :key="permission.id"
            :value="permission.id"
          >
            <span
              >{{ permission.label }} <small>{{ permission.id }}</small></span
            >
          </el-checkbox>
        </el-checkbox-group>
      </fieldset>
    </ManagementDialog>
    <el-dialog
      :model-value="vm.deleting.value !== null"
      :title="tr('删除角色', 'Delete role')"
      width="min(440px,94vw)"
      :close-on-click-modal="false"
      @update:model-value="vm.deleting.value = null"
    >
      <p>
        {{ tr('确认删除角色', 'Delete role') }}「{{
          vm.deleting.value?.name
        }}」？
      </p>
      <el-alert
        v-if="vm.mutation.error.value"
        :title="vm.mutation.error.value"
        type="error"
        :closable="false"
      /><template #footer>
        <el-button
          :disabled="vm.mutation.busy.value"
          @click="vm.deleting.value = null"
        >
          {{ tr('取消', 'Cancel') }} </el-button
        ><el-button
          type="danger"
          :loading="vm.mutation.busy.value"
          @click="vm.remove"
        >
          {{ tr('确认删除', 'Delete') }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>
