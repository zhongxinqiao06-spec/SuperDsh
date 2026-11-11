<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MarkdownContent from '@/components/MarkdownContent.vue'
import type { RuntimeNotice } from '@/types/workbench/models'
import { objectValue } from '@/utils/workbench/timeline'
import {
  answersComplete,
  inputForm,
  type QuestionAnswer,
} from '@/utils/workbench/interaction'

/** 采用运行时声明的actionId与问题选项；确认必须由用户明确选择。 */
const props = defineProps<{ notice: RuntimeNotice; disabled?: boolean }>()
const emit = defineEmits<{
  respond: [id: string, response: Record<string, unknown>]
}>()
const form = computed(() => inputForm(props.notice))
const drafts = ref<Record<string, QuestionAnswer>>({})
const actions = computed(() =>
  Array.isArray(props.notice.actions)
    ? props.notice.actions.map(objectValue)
    : [],
)
const details = computed(() =>
  String(
    props.notice.message ??
      props.notice.description ??
      objectValue(props.notice.details).reason ??
      '此任务需要你的确认或输入。',
  ),
)
watch(
  () => props.notice.id,
  () => {
    drafts.value = Object.fromEntries(
      form.value?.questions.map((question) => [
        question.id,
        {
          optionIds: [],
          customText: '',
          useCustom: !question.options.length && question.allowCustom,
        },
      ]) ?? [],
    )
  },
  { immediate: true },
)
function submit() {
  if (!answersComplete(form.value, drafts.value) || !form.value) return
  const answers = Object.fromEntries(
    form.value.questions.map((question) => {
      const answer = drafts.value[question.id]!
      return [
        question.id,
        {
          optionIds: answer.useCustom ? [] : answer.optionIds,
          ...(answer.useCustom ? { customText: answer.customText.trim() } : {}),
        },
      ]
    }),
  )
  emit('respond', props.notice.id, {
    actionId: form.value.actionId,
    input: { answers },
  })
}
</script>

<template>
  <section class="interaction-card">
    <h3>{{ notice.title ?? '等待你的回复' }}</h3>
    <MarkdownContent :content="details" />
    <template v-if="form">
      <fieldset v-for="question in form.questions" :key="question.id">
        <legend>{{ question.prompt }}</legend>
        <MarkdownContent v-if="question.detail" :content="question.detail" />
        <template v-if="drafts[question.id]">
          <el-checkbox-group
            v-if="question.multiple"
            v-model="drafts[question.id]!.optionIds"
            :disabled="disabled || drafts[question.id]!.useCustom"
            ><el-checkbox
              v-for="option in question.options"
              :key="option.id"
              :value="option.id"
              >{{ option.label }}
              <small>{{ option.description }}</small></el-checkbox
            ></el-checkbox-group
          >
          <el-radio-group
            v-else
            :model-value="drafts[question.id]!.optionIds[0]"
            :disabled="disabled || drafts[question.id]!.useCustom"
            @update:model-value="
              drafts[question.id]!.optionIds = [String($event)]
            "
            ><el-radio
              v-for="option in question.options"
              :key="option.id"
              :value="option.id"
              >{{ option.label }}
              <small>{{ option.description }}</small></el-radio
            ></el-radio-group
          >
          <el-checkbox
            v-if="question.allowCustom"
            v-model="drafts[question.id]!.useCustom"
            :disabled="disabled"
            >自行输入</el-checkbox
          ><el-input
            v-if="drafts[question.id]!.useCustom"
            v-model="drafts[question.id]!.customText"
            type="textarea"
            :disabled="disabled"
            :rows="3"
          />
        </template>
      </fieldset>
      <el-button
        type="primary"
        :disabled="disabled || !answersComplete(form, drafts)"
        @click="submit"
        >提交回复</el-button
      >
      <el-button
        v-for="action in actions.filter(
          (action) => (action.actionId ?? action.id) !== form?.actionId,
        )"
        :key="String(action.actionId ?? action.id)"
        :disabled="disabled"
        @click="
          emit('respond', notice.id, {
            actionId: action.actionId ?? action.id,
            input: {},
          })
        "
        >{{ action.label }}</el-button
      >
    </template>
    <div v-else class="actions">
      <el-button
        v-for="action in actions"
        :key="String(action.actionId ?? action.id)"
        :type="
          action.style === 'danger'
            ? 'danger'
            : action.style === 'primary'
              ? 'primary'
              : 'default'
        "
        :disabled="disabled"
        @click="
          emit('respond', notice.id, {
            actionId: action.actionId ?? action.id,
            input: {},
          })
        "
        >{{ action.label }}</el-button
      >
      <p v-if="!actions.length">此通知暂无可操作选项，请同步会话后重试。</p>
    </div>
  </section>
</template>
