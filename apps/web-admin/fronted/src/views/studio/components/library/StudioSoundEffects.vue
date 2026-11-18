<script setup lang="ts">
import { computed } from 'vue'
import type { StudioDocument, StudioAsset } from '@/types/studio/studio'
import type { AssetUseTarget } from '@/utils/studio/asset-use'
import { createUuid } from '@/utils/uuid'
import DurationField from '@/components/form/DurationField.vue'
import StudioMedia from '../StudioMedia.vue'

/** 音效跟随稳定镜头身份重排，时间和裁剪使用同一工程快照保存。 */
const model = defineModel<StudioDocument>({ required: true })
const props = defineProps<{
  project: string
  shotId: string
  assets: StudioAsset[]
  readonly?: boolean
}>()
const emit = defineEmits<{
  pick: [
    value: {
      title: string
      kinds: StudioAsset['kind'][]
      target: AssetUseTarget
    },
  ]
}>()
const effects = computed(() =>
  (model.value.soundEffects ?? []).filter(
    (effect) => effect.shotId === props.shotId,
  ),
)
function remove(id: string) {
  model.value.soundEffects = model.value.soundEffects?.filter(
    (effect) => effect.id !== id,
  )
}
</script>
<template>
  <section class="form-stack" aria-label="本镜音效">
    <div class="toolbar">
      <h3>本镜音效</h3>
      <span class="toolbar-spacer" /><el-button
        v-if="!readonly"
        @click="
          emit('pick', {
            title: '为当前镜头添加音效',
            kinds: ['audio'],
            target: { kind: 'effect', shotId, id: createUuid() },
          })
        "
        >从媒体库添加音效</el-button
      >
    </div>
    <p v-if="!effects.length" class="studio-meta">
      音效随本镜移动，开始时间相对本镜原画面。
    </p>
    <article
      v-for="effect in effects"
      :key="effect.id"
      class="form-stack effect-item"
    >
      <div class="toolbar">
        <strong>{{
          assets.find((asset) => asset.id === effect.assetId)?.name || '音效'
        }}</strong
        ><span class="toolbar-spacer" /><el-button
          v-if="!readonly"
          link
          @click="remove(effect.id)"
          >移除音效</el-button
        >
      </div>
      <StudioMedia
        :project="project"
        :asset="effect.assetId"
        kind="audio"
        controls
      />
      <div class="effect-fields">
        <DurationField
          v-model="effect.start"
          label="在本镜的开始时间"
          :disabled="readonly"
          :min="0"
        /><DurationField
          v-model="effect.trimStart"
          label="音效素材入点"
          :disabled="readonly"
          :min="0"
        /><DurationField
          v-model="effect.trimEnd"
          label="音效素材出点"
          :disabled="readonly"
          :min="effect.trimStart"
          :placeholder="
            assets.find((asset) => asset.id === effect.assetId)?.durationMs ??
            undefined
          "
        /><label class="field"
          >音量 · {{ Math.round(effect.volume * 100) }}%<input
            v-model.number="effect.volume"
            type="range"
            min="0"
            max="2"
            step=".05"
            :disabled="readonly"
        /></label>
      </div>
    </article>
  </section>
</template>
<style scoped>
.effect-item {
  border-top: 1px solid var(--border);
  padding-top: var(--field-gap);
}
.effect-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: var(--field-gap);
}
</style>
