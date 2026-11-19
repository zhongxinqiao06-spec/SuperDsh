<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { EpisodeInput, SeriesEpisode } from '@/types/studio/series'
import { episodeDraft, storyFields } from '@/utils/studio/series'
import { useMutation } from '@/composables/use-mutation'
import { useSeriesDraftGuard } from '@/composables/studio/use-series-draft-guard'
import ScrollPanel from '@/components/layout/ScrollPanel.vue'

/** 当前集的阅读式编辑；远端修订变化保留本地草稿，保存冲突不会悄悄覆盖。 */
const props = defineProps<{
  episode: SeriesEpisode
  allowed: boolean
  busy: boolean
  save: (id: string, value: EpisodeInput) => Promise<void>
  confirm: (episode: SeriesEpisode) => Promise<void>
  pending?: boolean
}>()
const emit = defineEmits<{ ai: []; dirty: [boolean] }>()
const form = ref(episodeDraft(props.episode)),
  baseline = ref(JSON.stringify(form.value))
const mutation = useMutation()
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value)
const disabled = computed(
  () =>
    !props.allowed || props.episode.locked || props.busy || mutation.busy.value,
)
watch(dirty, (value) => emit('dirty', value), { immediate: true })
watch(
  () => props.episode.storyRevision,
  () => {
    if (!dirty.value) reset()
  },
)
function reset() {
  form.value = episodeDraft(props.episode)
  baseline.value = JSON.stringify(form.value)
}
async function handleSave() {
  if (!dirty.value) return true
  return mutation.run(async () => {
    if (!form.value.title.trim()) throw new Error('请填写本集名称')
    await props.save(props.episode.id, form.value)
    baseline.value = JSON.stringify(form.value)
  })
}
async function handleConfirm() {
  if (!(await handleSave())) return
  await nextTick()
  await mutation.run(() => props.confirm(props.episode))
}
useSeriesDraftGuard(() => dirty.value, handleSave)
defineExpose({ save: handleSave, dirty })
</script>
<template>
  <ScrollPanel class="series-panel" label="本集故事" :reset-key="episode.id">
    <template #header
      ><div class="toolbar">
        <h2 class="series-grow">
          第{{ episode.number }}集 · {{ episode.title }}
        </h2>
        <el-tag v-if="episode.locked" type="info">已锁定</el-tag
        ><span v-else class="studio-meta">{{
          dirty
            ? '尚未保存'
            : episode.confirmedStoryRevision === episode.storyRevision
              ? '已确认'
              : '草稿已保存'
        }}</span>
      </div></template
    >
    <div class="form-stack">
      <el-alert
        v-if="mutation.error.value"
        :title="mutation.error.value"
        type="error"
        :closable="false"
      />
      <el-alert
        v-if="episode.locked"
        title="本集已锁定。需修改时，先在分集目录明确解锁；既有交付仍保留。"
        type="info"
        :closable="false"
      />
      <label class="field"
        >本集名称<el-input
          v-model="form.title"
          maxlength="120"
          :disabled="disabled"
          aria-label="本集名称"
      /></label>
      <label
        v-for="field in storyFields"
        :key="field.key"
        class="field series-story-field"
        ><strong>{{ field.label }}</strong
        ><el-input
          v-model="form.story[field.key]"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 10 }"
          :placeholder="field.placeholder"
          :aria-label="field.label"
          maxlength="12000"
          :disabled="disabled"
      /></label>
      <label class="field"
        >本集目标时长（秒）<el-input-number
          :model-value="form.targetDurationMs / 1000"
          :min="1"
          :max="3600"
          :disabled="disabled"
          aria-label="本集目标时长"
          @update:model-value="
            form.targetDurationMs = Math.round(($event ?? 45) * 1000)
          "
      /></label>
    </div>
    <template #footer>
      <p v-if="pending" class="studio-meta">
        本集还有待审阅的 AI 建议，可先采用或放弃后再确认。
      </p>
      <div class="toolbar">
        <el-button
          :disabled="disabled || !dirty"
          :loading="mutation.busy.value"
          @click="handleSave"
          >保存草稿</el-button
        ><el-button :disabled="disabled" @click="emit('ai')"
          >AI 协助修改</el-button
        ><el-button
          type="primary"
          :disabled="disabled || pending || !form.story.synopsis.trim()"
          @click="handleConfirm"
          >确认本集并进入制作</el-button
        >
      </div>
      <p v-if="!form.story.synopsis.trim()" class="studio-meta">
        先补充“本集要讲什么”，也可借助 AI 起草。
      </p>
    </template>
  </ScrollPanel>
</template>
