<script setup lang="ts">
import { computed } from 'vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ExpandableText from '@/components/base/ExpandableText.vue'
import type {
  Dialogue,
  Generation,
  Shot,
  StudioCatalog,
} from '@/types/studio/studio'

/** 汇总当前确认的镜头、配音和模型；确认前不提交付费任务。 */
const open = defineModel<boolean>({ required: true })
const video = defineModel<string>('video', { required: true })
const referenceVideo = defineModel<string>('referenceVideo', { required: true })
const speech = defineModel<string>('speech', { required: true })
const props = defineProps<{
  revision?: number
  plan: Generation
  shots: Shot[]
  lines: Dialogue[]
  hasReference: (shot: Shot) => boolean
  catalog?: StudioCatalog
  error: string
  busy: boolean
}>()
const emit = defineEmits<{ submit: [] }>()
const models = computed(() => props.catalog?.configurations ?? [])
const videoModels = computed(() =>
  models.value.filter((m) => m.capability === 'video.generate'),
)
const videoSelections = computed(() =>
  [
    {
      needed: props.shots.some((s) => !props.hasReference(s)),
      label: '文生视频模型',
      automatic: false,
      models: videoModels.value.filter(
        (m) => m.parameters.inputMode !== 'reference',
      ),
      selection: video,
    },
    {
      needed: props.shots.some(props.hasReference),
      label: '参考图视频模型',
      automatic: false,
      models: videoModels.value.filter(
        (m) => m.parameters.inputMode === 'reference',
      ),
      selection: referenceVideo,
    },
    {
      needed: props.lines.length > 0,
      label: '配音模型',
      automatic: true,
      models: models.value.filter((m) => m.capability === 'speech.synthesize'),
      selection: speech,
    },
  ].filter((choice) => choice.needed),
)
const missingModel = computed(
  () =>
    !props.plan.export &&
    videoSelections.value.some(
      (choice) =>
        !(
          choice.automatic &&
          !choice.selection.value &&
          choice.models.length
        ) && !choice.models.some((m) => m.id === choice.selection.value),
    ),
)
</script>

<template>
  <ManagementDialog
    v-model="open"
    :title="plan.export ? '确认导出当前工程' : '确认生成任务'"
    :busy="busy"
    :error="error"
    :submit-disabled="missingModel"
    :submit-text="plan.export ? '导出这一版 MP4' : '检查生成方案'"
    @submit="emit('submit')"
  >
    <div class="studio-form">
      <p v-if="plan.export">
        工程版本
        {{ revision ?? '当前' }}：使用已采用的镜头和配音，按当前剪辑与字幕生成
        MP4。后续编辑不会改动此次导出的版本。
      </p>
      <template v-else>
        <p>
          镜头 {{ shots.length }} 个，共
          {{ shots.reduce((n, s) => n + Math.ceil(s.duration / 1000), 0) }}
          秒。配音 {{ lines.length }} 句，共
          {{ lines.reduce((n, l) => n + [...l.text].length, 0) }} 字。
        </p>
        <label
          v-for="choice in videoSelections"
          :key="choice.label"
          class="field"
        >
          {{ choice.label }}
          <select
            v-model="choice.selection.value"
            class="native-control"
            :required="!choice.automatic"
          >
            <option v-if="choice.automatic && choice.models.length" value="">
              角色音色或默认模型
            </option>
            <option v-if="!choice.models.length" disabled value="">
              暂无可用配置
            </option>
            <option v-for="m in choice.models" :key="m.id" :value="m.id">
              {{ m.name }}
            </option>
          </select>
        </label>
        <ul
          v-if="shots.length"
          class="generation-shot-list"
          aria-label="本次生成镜头"
        >
          <li v-for="s in shots" :key="s.id">
            <strong
              >{{ s.scene || '当前镜头' }} · {{ s.duration / 1000 }} 秒</strong
            >
            <ExpandableText
              :text="s.action || '尚未填写镜头要求'"
              :lines="3"
              label="镜头要求"
            />
          </li>
        </ul>
        <ul v-if="lines.length" aria-label="本次生成台词">
          <li v-for="(line, index) in lines" :key="line.id">
            <strong>第 {{ index + 1 }} 句</strong
            ><ExpandableText :text="line.text" :lines="2" label="台词" />
          </li>
        </ul>
        <p v-if="missingModel" class="studio-meta">
          请为本次任务选择已启用的模型配置。
        </p>
      </template>
    </div>
  </ManagementDialog>
</template>

<style scoped>
.generation-shot-list {
  display: grid;
  gap: var(--field-gap);
  margin: 0;
  padding: 0;
  list-style: none;
}
.generation-shot-list li {
  display: grid;
  gap: var(--control-gap);
  min-width: 0;
  padding-block: var(--field-gap);
  border-block: 1px solid var(--border);
}
</style>
