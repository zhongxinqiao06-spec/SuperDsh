<script setup lang="ts">
import { ref, watch } from 'vue'
import { navigationApi } from '@/api/console/navigation-api'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { roleLabel } from '@/utils/access/role-labels'
import type { Product } from '@/types/console/navigation'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
const props = defineProps<{
  product: Product
  roles: { id: string; name: string }[]
}>()
defineEmits<{ close: [] }>()
const { tr } = usePreferences()
const roleId = ref(
  props.roles.find(
    (r) =>
      r.id ===
      (props.product === 'office' ? 'member' : 'entertainment_creator'),
  )?.id ??
    props.roles[0]?.id ??
    '',
)
// 角色预览使用服务端计算后的树，避免借用当前管理员的权限渲染预览结果。
const preview = useResource((signal) =>
  navigationApi.preview(props.product, roleId.value, signal),
)
watch(roleId, () => {
  preview.data.value = null
  void preview.reload()
})
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="tr('角色预览', 'Role preview')"
    readonly
    @update:model-value="$emit('close')"
  >
    <label class="field"
      >{{ tr('预览角色', 'Preview role')
      }}<el-select v-model="roleId" aria-label="预览角色">
        <el-option
          v-for="role in roles"
          :key="role.id"
          :value="role.id"
          :label="roleLabel(role.id, tr, role.name)"
        /> </el-select
    ></label>
    <ResourceStatus
      :loading="preview.loading.value"
      :error="preview.error.value"
      :empty="!!preview.data.value && !preview.data.value.items.length"
      empty-title="该角色没有可见菜单"
      @retry="preview.reload"
    />
    <ul v-if="preview.data.value?.items.length" class="menu-preview-tree">
      <li
        v-for="root in preview.data.value.items.filter(
          (item) => !item.parentId,
        )"
        :key="root.id"
      >
        <strong>{{ root.title }}</strong>
        <ul v-if="root.kind === 'group'">
          <li
            v-for="child in preview.data.value.items.filter(
              (item) => item.parentId === root.id,
            )"
            :key="child.id"
          >
            {{ child.title }}
          </li>
        </ul>
      </li>
    </ul>
  </ManagementDialog>
</template>
<style scoped>
.menu-preview-tree {
  display: grid;
  gap: 12px;
  list-style: none;
  padding: 0;
  margin: 0;
}
.menu-preview-tree ul {
  padding-inline-start: 1.5rem;
  color: var(--muted-foreground);
  line-height: 1.8;
}
</style>
