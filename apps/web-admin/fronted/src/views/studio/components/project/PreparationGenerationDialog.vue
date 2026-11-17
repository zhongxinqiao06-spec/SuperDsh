<script setup lang="ts">
import { createUuid } from '@/utils/uuid'
import { computed, ref, watch } from 'vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ExpandableText from '@/components/base/ExpandableText.vue'
import { preparationApi } from '@/api/studio/preparation-api'
import type {
  PreparationIntent,
  PreparationPlan,
} from '@/types/studio/preparation'
import type { StudioProject, StudioCatalog } from '@/types/studio/studio'

/** 两次点击分别进行只读预检和收费确认，重试保持原制作意图号。 */
const props = defineProps<{
  project: StudioProject
  catalog?: StudioCatalog
  kind: PreparationIntent['kind']
  target: string
  title: string
  initialVoice?: string
  initialText?: string
  save: () => Promise<void>
}>()
const emit = defineEmits<{ close: []; submitted: [] }>()
const open = ref(true),
  busy = ref(false),
  error = ref(''),
  configuration = ref(''),
  voice = ref(props.initialVoice ?? ''),
  text = ref(props.initialText ?? ''),
  prompt = ref(''),
  useReference = ref(true),
  preview = ref<PreparationPlan>()
const models = computed(
  () =>
    props.catalog?.configurations.filter(
      (c) =>
        c.capability ===
        (props.kind === 'voice' ? 'speech.synthesize' : 'image.generate'),
    ) ?? [],
)
const voices = computed(
  () =>
    models.value
      .find((c) => c.id === configuration.value)
      ?.parameters.voices?.split(',')
      .filter(Boolean) ?? [],
)
watch(
  models,
  (items) => {
    if (!items.some((c) => c.id === configuration.value))
      configuration.value =
        items.find((c) =>
          props.catalog?.defaults.some((d) => d.configurationId === c.id),
        )?.id ??
        items[0]?.id ??
        ''
  },
  { immediate: true },
)
watch(
  voices,
  (values) => {
    if (!values.includes(voice.value)) voice.value = values[0] ?? ''
  },
  { immediate: true },
)
watch(
  () => [
    configuration.value,
    voice.value,
    text.value,
    prompt.value,
    useReference.value,
  ],
  () => {
    preview.value = undefined
  },
)
let attempt: { signature: string; body: PreparationIntent } | undefined
async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await props.save()
    const draft = {
      revision: props.project.revision,
      kind: props.kind,
      target: props.target,
      configuration: configuration.value,
      prompt: prompt.value,
      voice: voice.value,
      text: text.value,
      useReference: useReference.value,
    }
    const signature = JSON.stringify(draft)
    if (attempt?.signature !== signature) {
      attempt = {
        signature,
        body: { ...draft, requestKey: createUuid() },
      }
      preview.value = undefined
    }
    if (!preview.value?.planHash)
      preview.value = await preparationApi.plan(
        props.project.id,
        attempt.body,
        true,
      )
    else {
      await preparationApi.plan(
        props.project.id,
        { ...attempt.body, planHash: preview.value.planHash },
        false,
      )
      emit('submitted')
      open.value = false
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <ManagementDialog
    v-model="open"
    :title="title"
    :busy="busy"
    :error="error"
    :submit-text="preview?.plan ? '确认提交本次生成' : '检查本次方案'"
    :submit-disabled="
      !configuration || (kind === 'voice' && (!voice || !text.trim()))
    "
    @submit="submit"
    @update:model-value="(value) => !value && emit('close')"
  >
    <div class="form-stack">
      <el-alert
        v-if="!models.length"
        title="当前产品没有可用模型，请由管理员在模型配置中启用对应能力。"
        type="info"
        :closable="false"
      />
      <label class="field"
        >生成模型<el-select
          v-model="configuration"
          aria-label="生成模型"
          :disabled="busy"
          ><el-option
            v-for="model in models"
            :key="model.id"
            :value="model.id"
            :label="model.name" /></el-select
      ></label>
      <template v-if="kind === 'voice'"
        ><label class="field"
          >角色音色<el-select
            v-model="voice"
            aria-label="角色音色"
            :disabled="busy"
            ><el-option
              v-for="item in voices"
              :key="item"
              :value="item"
              :label="item" /></el-select></label
        ><label class="field"
          >试听台词<el-input
            v-model="text"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            aria-label="试听台词"
            :disabled="busy" /></label
      ></template>
      <template v-else
        ><label class="field"
          >补充画面要求<el-input
            v-model="prompt"
            type="textarea"
            :rows="3"
            maxlength="12000"
            placeholder="系统会同时带入作品风格、角色设定或本镜头动作，无需重复填写。"
            aria-label="补充画面要求"
            :disabled="busy" /></label
        ><el-checkbox v-model="useReference" :disabled="busy"
          >沿用当前已关联的参考图</el-checkbox
        ></template
      >
      <section v-if="preview?.plan" class="preparation-plan">
        <h3>本次制作方案</h3>
        <p>{{ preview.plan.title }} · {{ preview.plan.model }}</p>
        <p v-if="kind === 'voice'">
          音色 {{ preview.plan.voice }} · {{ preview.plan.text.length }} 字
        </p>
        <p v-else>生成 1 张画面 · {{ preview.plan.references }} 张参考图</p>
        <ExpandableText :text="preview.plan.text" label="制作内容" />
        <p class="studio-meta">
          本次费用由供应商结算，目前无法预估。确认后提交；结果先进入候选区，不自动替换作品。
        </p>
        <el-button text :disabled="busy" @click="preview = undefined"
          >返回修改方案</el-button
        >
      </section>
    </div>
  </ManagementDialog>
</template>
