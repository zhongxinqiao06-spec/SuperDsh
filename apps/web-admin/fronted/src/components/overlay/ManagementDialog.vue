<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { ElMessageBox } from 'element-plus'
import { usePreferences } from '@/store/modules/preferences'
import { useProductEditorGuard } from '@/composables/console/use-product-editor-guard'
/** 统一提交弹窗：正文独立滚动，提交失败保留草稿；脏状态由领域用例提供。 */
const props = defineProps<{
  modelValue: boolean
  title: string
  busy?: boolean
  error?: string
  readonly?: boolean
  width?: string
  submitText?: string
  submitDisabled?: boolean
  dirty?: boolean
  /** 领域已提供完整导航保护时关闭本组件的产品级保护，避免重复询问。 */
  navigationGuard?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  submit: []
}>()
const preferences = usePreferences()
const formId = `management-form-${useId()}`
const form = ref<HTMLFormElement>()
const errorBlock = ref<HTMLElement>()
const changed = ref(false)
watch(
  () => props.modelValue,
  () => {
    changed.value = false
  },
)
const confirmingNavigation = useProductEditorGuard({
  open: () => props.modelValue && props.navigationGuard !== false,
  busy: () => !!props.busy,
  dirty: () => !props.readonly && (props.dirty || changed.value),
  save: () => form.value?.requestSubmit(),
})
async function requestClose(done: () => void): Promise<void> {
  if (props.busy) return
  if (props.dirty) {
    try {
      await ElMessageBox.confirm(
        preferences.tr(
          '未保存的修改将丢失，确定关闭？',
          'Discard unsaved changes?',
        ),
        preferences.tr('未保存的修改', 'Unsaved changes'),
        {
          confirmButtonText: preferences.tr('放弃修改', 'Discard'),
          cancelButtonText: preferences.tr('继续编辑', 'Keep editing'),
          type: 'warning',
          closeOnClickModal: false,
        },
      )
    } catch {
      return
    }
  }
  done()
}
function submit(): void {
  if (!props.readonly && !props.busy && !props.submitDisabled) emit('submit')
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    class="management-dialog"
    :width="width ?? 'min(672px, calc(100vw - 32px))'"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy && !confirmingNavigation"
    :show-close="!busy"
    :before-close="requestClose"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template #header="{ titleId, titleClass }">
      <div class="management-dialog-heading">
        <div class="sheet-title">
          <span class="sheet-symbol" aria-hidden="true"
            ><AppIcon :name="readonly ? 'file-text' : 'settings'"
          /></span>
          <h2 :id="titleId" :class="titleClass">{{ title }}</h2>
        </div>
        <slot name="toolbar" />
      </div>
    </template>
    <form
      :id="formId"
      ref="form"
      class="stack"
      @submit.prevent="submit"
      @input="changed = true"
      @change="changed = true"
    >
      <div v-if="error" ref="errorBlock" class="dialog-error">
        <el-alert :title="error" type="error" :closable="false" show-icon />
      </div>
      <slot />
    </form>
    <template #footer>
      <!-- 完整错误留在正文，避免长异常挤占固定底栏和提交按钮。 -->
      <el-button
        v-if="error"
        text
        type="danger"
        @click="errorBlock?.scrollIntoView({ block: 'nearest' })"
        >{{
          preferences.tr('操作未完成，查看错误', 'Action failed. View details')
        }}</el-button
      >
      <div class="dialog-actions">
        <slot name="footer-leading" />
        <el-button
          :disabled="busy"
          @click="requestClose(() => emit('update:modelValue', false))"
        >
          {{
            preferences.tr(
              readonly ? '关闭' : '取消',
              readonly ? 'Close' : 'Cancel',
            )
          }}
        </el-button>
        <el-button
          v-if="!readonly"
          type="primary"
          native-type="submit"
          :loading="busy"
          :form="formId"
          :disabled="submitDisabled"
        >
          {{ submitText ?? preferences.tr('保存', 'Save') }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>
<style scoped>
.management-dialog-heading {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: var(--field-gap);
}
.management-dialog-heading h2 {
  margin: 0;
}
</style>
