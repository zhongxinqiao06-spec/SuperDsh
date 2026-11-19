<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import type {
  SeriesProposal,
  StoryField,
  StudioSeries,
} from '@/types/studio/series'
import { seriesApi } from '@/api/studio/series-api'
import { createUuid } from '@/utils/uuid'
import { storyFields } from '@/utils/studio/series'
import { useMutation } from '@/composables/use-mutation'
import ScrollPanel from '@/components/layout/ScrollPanel.vue'
import AiTextComparison from '@/components/form/AiTextComparison.vue'
import SeriesAiExecution from './SeriesAiExecution.vue'
import { errorMessage } from '@/utils/errors'

/** 分集建议使用公共 DSH 传输和文本对比；逐字段采用由服务端校验冻结基线。 */
const props = defineProps<{
  series: StudioSeries
  currentId: string
  allowed: boolean
  beforeGenerate: () => Promise<boolean>
  reload: () => Promise<void>
  resolve: (
    record: SeriesProposal,
    action: 'apply' | 'discard',
    selected: { episodeId: string; fields: StoryField[] }[],
  ) => Promise<void>
}>()
const emit = defineEmits<{ close: []; pending: [string[]] }>()
const records = ref<SeriesProposal[]>([]),
  selectedId = ref(''),
  instruction = ref(''),
  scope = ref<string[]>([props.currentId]),
  chosen = ref<string[]>([])
const mutation = useMutation(),
  abort = new AbortController()
const autoStart = ref(''),
  running = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let restored = false
let request = { signature: '', key: '' }
const current = computed(() =>
  records.value.find((record) => record.id === selectedId.value),
)
const pending = computed(() =>
  records.value.filter((record) => ['waiting', 'ready'].includes(record.state)),
)
const changes = computed(
  () =>
    current.value?.suggestions.flatMap((item) => {
      const original = current.value?.base.find(
        (base) => base.episodeId === item.episodeId,
      )
      return storyFields
        .filter(
          (field) =>
            (original?.story[field.key] ?? '') !== item.story[field.key],
        )
        .map((field) => ({
          key: item.episodeId + ':' + field.key,
          episodeId: item.episodeId,
          field: field.key,
          title: `${original?.title ?? '分集'} · ${field.label}`,
          original: original?.story[field.key] ?? '',
          suggestion: item.story[field.key],
        }))
    }) ?? [],
)
// 收起保留未发送要求；只有尚未编辑的默认单集范围才跟随当前选集。
watch(
  () => props.currentId,
  (value, previous) => {
    if (
      !current.value &&
      !instruction.value.trim() &&
      scope.value.length === 1 &&
      scope.value[0] === previous
    )
      scope.value = [value]
  },
)
watch(
  () => changes.value.map((item) => item.key).join(','),
  () => {
    chosen.value = changes.value.map((item) => item.key)
  },
)
watch(pending, (value) =>
  emit('pending', [
    ...new Set(
      value.flatMap((record) => record.base.map((item) => item.episodeId)),
    ),
  ]),
)
async function refresh() {
  const result = await seriesApi.proposals(props.series.id, abort.signal)
  if (abort.signal.aborted) return
  records.value = result
  if (!restored) {
    selectedId.value =
      result.find(
        (record) =>
          record.base.some((item) => item.episodeId === props.currentId) &&
          ['waiting', 'ready'].includes(record.state),
      )?.id ?? ''
    restored = true
  }
}
async function poll() {
  try {
    if (!mutation.busy.value) await refresh()
  } catch (cause) {
    if (!abort.signal.aborted) mutation.error.value = errorMessage(cause)
  } finally {
    if (!abort.signal.aborted) timer = setTimeout(poll, 2500)
  }
}
async function generate() {
  if (
    !props.allowed ||
    !scope.value.length ||
    !instruction.value.trim() ||
    !(await props.beforeGenerate())
  )
    return
  await mutation.run(async () => {
    await nextTick()
    const body = {
      revision: props.series.revision,
      episodeIds: scope.value,
      instruction: instruction.value.trim(),
    }
    const signature = JSON.stringify(body)
    if (request.signature !== signature)
      request = { signature, key: createUuid() }
    const result = await seriesApi.propose(props.series.id, {
      ...body,
      requestKey: request.key,
    })
    records.value = [
      result,
      ...records.value.filter((record) => record.id !== result.id),
    ]
    selectedId.value = result.id
    autoStart.value = result.id
    await props.reload()
  })
}
async function handleResolve(action: 'apply' | 'discard') {
  const record = current.value
  if (!record) return
  await mutation.run(async () => {
    if (!(await props.beforeGenerate())) return
    const selected = record.base
      .map((item) => ({
        episodeId: item.episodeId,
        fields: changes.value
          .filter(
            (change) =>
              change.episodeId === item.episodeId &&
              chosen.value.includes(change.key),
          )
          .map((change) => change.field),
      }))
      .filter((item) => item.fields.length)
    await props.resolve(record, action, selected)
    autoStart.value = ''
    await refresh()
  })
}
onScopeDispose(() => {
  abort.abort()
  clearTimeout(timer)
})
void poll()
</script>
<template>
  <ScrollPanel class="series-panel series-assistant" label="AI 分集编排">
    <template #header
      ><div class="toolbar">
        <h2 class="series-grow">AI 协助编排</h2>
        <el-button link @click="emit('close')">收起</el-button>
      </div></template
    >
    <div class="form-stack">
      <el-alert
        v-if="mutation.error.value"
        :title="mutation.error.value"
        type="error"
        :closable="false"
      />
      <label v-if="records.length" class="field"
        >修改记录<el-select v-model="selectedId" aria-label="分集修改记录"
          ><el-option label="发起新的编排" value="" /><el-option
            v-for="record in records"
            :key="record.id"
            :value="record.id"
            :label="`${record.state === 'waiting' ? '等待建议' : record.state === 'ready' ? '待采用' : record.state === 'applied' ? '已采用' : '已放弃'} · ${record.instruction.slice(0, 35)}`" /></el-select
      ></label>
      <template v-if="!current">
        <label class="field"
          >本次修改范围<el-select
            v-model="scope"
            multiple
            aria-label="本次修改范围"
            ><el-option
              v-for="episode in series.episodes"
              :key="episode.id"
              :value="episode.id"
              :label="`第${episode.number}集 · ${episode.title}${episode.locked ? '（已锁定）' : ''}`"
              :disabled="
                episode.locked ||
                pending.some((record) =>
                  record.base.some((item) => item.episodeId === episode.id),
                )
              " /></el-select
        ></label>
        <label class="field"
          >希望怎么调整<el-input
            v-model="instruction"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 10 }"
            maxlength="2000"
            aria-label="分集编排要求"
            placeholder="例如：按整剧构想起草所选分集，前两集建立伙伴关系，第三集揭示秘密。"
        /></label>
        <p class="studio-meta">
          建议先对比，采用后才改变分集故事。已锁定分集和镜头、配音不参与本次改写。
        </p>
      </template>
      <template v-else>
        <p>{{ current.instruction }}</p>
        <p class="studio-meta">
          范围：{{ current.base.map((item) => item.title).join('、') }}
        </p>
        <SeriesAiExecution
          :key="current.id"
          :proposal="current"
          :auto-start="autoStart === current.id"
          :allowed="allowed"
          @busy="running = $event"
          @sent="autoStart = ''"
        />
        <div
          v-for="change in changes"
          :key="change.key"
          class="form-stack series-diff"
        >
          <el-checkbox
            :model-value="chosen.includes(change.key)"
            :disabled="current.state !== 'ready' || !allowed"
            @update:model-value="
              chosen = $event
                ? [...chosen, change.key]
                : chosen.filter((key) => key !== change.key)
            "
            >{{ change.title }}</el-checkbox
          ><AiTextComparison
            :model-value="change.suggestion"
            :original="change.original"
            disabled
            suggestion-label="AI 建议 · 采用后可继续修改"
          />
        </div>
        <p
          v-if="current.state === 'ready' && !changes.length"
          class="studio-meta"
        >
          这次建议没有改变故事，可以放弃并提出更具体的要求。
        </p>
        <p v-if="current.state === 'waiting'" role="status" class="studio-meta">
          等待完整建议，可收起面板继续查看。刷新后仍可恢复本次记录。
        </p>
      </template>
    </div>
    <template #footer
      ><div class="toolbar">
        <el-button
          v-if="!current"
          type="primary"
          :disabled="!allowed || !scope.length || !instruction.trim()"
          :loading="mutation.busy.value"
          @click="generate"
          >生成编排建议</el-button
        >
        <el-button
          v-if="current?.state === 'ready'"
          type="primary"
          :disabled="!allowed || !chosen.length || running"
          :loading="mutation.busy.value"
          @click="handleResolve('apply')"
          >采用所选修改</el-button
        >
        <el-button
          v-if="current && ['ready', 'waiting'].includes(current.state)"
          :disabled="!allowed || mutation.busy.value"
          @click="handleResolve('discard')"
          >放弃本次建议</el-button
        >
      </div></template
    >
  </ScrollPanel>
</template>
