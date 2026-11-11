<script setup lang="ts">
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import type {
  ProjectDraft,
  useProjectManager,
} from '@/composables/workbench/use-project-manager'
/** 项目编辑器仅发布受控事件，目录请求与写操作由工作台所属用例处理。 */
defineProps<{ vm: ReturnType<typeof useProjectManager> }>()
const emit = defineEmits<{
  'update:draft': [value: Partial<ProjectDraft>]
  'update:path': [value: string]
  close: []
  save: []
  browse: [path?: string]
  closeBrowser: []
  chooseDirectory: []
}>()
</script>
<template>
  <ManagementDialog
    :model-value="!!vm.editing.value"
    :title="vm.editing.value === 'new' ? '新建项目' : '编辑项目'"
    :busy="vm.mutation.busy.value"
    :error="vm.mutation.error.value"
    @update:model-value="emit('close')"
    @submit="emit('save')"
  >
    <label
      >设备<el-select
        :model-value="vm.draft.connectorId"
        :disabled="vm.editing.value !== 'new' || vm.mutation.busy.value"
        aria-label="项目设备"
        @update:model-value="emit('update:draft', { connectorId: $event })"
        ><el-option
          v-for="device in vm.editing.value === 'new'
            ? vm.online.value
            : vm.devices.value"
          :key="device.id"
          :label="device.name"
          :value="device.id" /></el-select
    ></label>
    <label
      >工作目录
      <div class="toolbar">
        <el-input
          :model-value="vm.draft.workspacePath"
          :disabled="vm.editing.value !== 'new' || vm.mutation.busy.value"
          maxlength="4096"
          aria-label="项目工作目录"
          @update:model-value="emit('update:draft', { workspacePath: $event })"
        /><el-button
          v-if="vm.editing.value === 'new'"
          :disabled="!vm.draft.connectorId || vm.mutation.busy.value"
          @click="emit('browse')"
          >浏览目录</el-button
        >
      </div></label
    >
    <label
      >项目名称<el-input
        :model-value="vm.draft.name"
        :disabled="vm.mutation.busy.value"
        maxlength="255"
        aria-label="项目名称"
        @update:model-value="emit('update:draft', { name: $event })"
    /></label>
  </ManagementDialog>
  <el-dialog
    :model-value="vm.browser.value"
    title="选择工作目录"
    width="min(768px, 94vw)"
    :close-on-click-modal="false"
    @update:model-value="emit('closeBrowser')"
  >
    <div class="toolbar">
      <el-input
        :model-value="vm.path.value"
        aria-label="浏览目录路径"
        @update:model-value="emit('update:path', $event)"
        @keyup.enter="emit('browse', vm.path.value)"
      /><el-button @click="emit('browse', vm.path.value)">打开</el-button>
    </div>
    <ResourceStatus
      :loading="vm.browsing.value"
      :error="vm.browseError.value"
      @retry="emit('browse', vm.path.value)"
    />
    <div class="stack">
      <el-button
        v-for="directory in vm.directories.value"
        :key="directory.path"
        text
        @click="emit('browse', directory.path)"
        >{{ directory.name }}</el-button
      >
    </div>
    <p
      v-if="
        !vm.browsing.value &&
        !vm.browseError.value &&
        !vm.directories.value.length
      "
    >
      当前目录下没有子目录。
    </p>
    <template #footer
      ><el-button @click="emit('closeBrowser')">取消</el-button
      ><el-button
        type="primary"
        :disabled="!vm.canChooseDirectory.value"
        @click="emit('chooseDirectory')"
        >选择此目录</el-button
      ></template
    >
  </el-dialog>
</template>
