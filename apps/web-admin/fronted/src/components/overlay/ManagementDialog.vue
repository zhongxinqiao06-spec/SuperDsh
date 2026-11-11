<script setup lang="ts">
import { useId } from 'vue'
import { ElMessageBox } from 'element-plus'
import { usePreferences } from '@/store/modules/preferences'
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
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  submit: []
}>()
const preferences = usePreferences()
const formId = `management-form-${useId()}`
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
    :close-on-press-escape="!busy"
    :show-close="!busy"
    :before-close="requestClose"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <form :id="formId" class="stack" @submit.prevent="submit">
      <slot />
    </form>
    <template #footer>
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
        class="dialog-error"
      />
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
