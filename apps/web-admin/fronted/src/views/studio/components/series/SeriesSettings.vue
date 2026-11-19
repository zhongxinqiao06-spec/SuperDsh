<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { StudioSeries } from '@/types/studio/series'
import type { StudioAsset } from '@/types/studio/studio'
import { useMutation } from '@/composables/use-mutation'
import { useSeriesDraftGuard } from '@/composables/studio/use-series-draft-guard'
import StudioAssetPicker from '../library/StudioAssetPicker.vue'
import StudioAssetCard from '../library/StudioAssetCard.vue'

/** 本剧固定引用素材版本；选择更新哪些集后才同步，保留每集的手工覆盖。 */
const props = defineProps<{
  series: StudioSeries
  allowed: boolean
  busy: boolean
  save: (ids: string[]) => Promise<void>
  apply: (ids: string[]) => Promise<void>
}>()
const assets = ref<StudioAsset[]>([...props.series.settings]),
  selected = ref<string[]>([]),
  picker = ref(false)
const mutation = useMutation()
const baseline = ref(JSON.stringify(assets.value.map((asset) => asset.id)))
const dirty = computed(
  () =>
    JSON.stringify(assets.value.map((asset) => asset.id)) !== baseline.value,
)
watch(
  () => props.series.settingsRevision,
  () => {
    if (!dirty.value) {
      assets.value = [...props.series.settings]
      baseline.value = JSON.stringify(assets.value.map((asset) => asset.id))
    }
  },
)
async function select(asset: StudioAsset) {
  const index = assets.value.findIndex((item) => item.family === asset.family)
  if (index >= 0) assets.value.splice(index, 1, asset)
  else assets.value.push(asset)
  return asset
}
async function handleSave() {
  return mutation.run(async () => {
    await props.save(assets.value.map((asset) => asset.id))
    baseline.value = JSON.stringify(assets.value.map((asset) => asset.id))
  })
}
async function handleApply() {
  try {
    await ElMessageBox.confirm(
      `将当前本剧设定同步到选中的 ${selected.value.length} 集。仍沿用旧版本的引用会更新，本集独立调整会保留，已交付成片不改变。`,
      '确认更新范围',
      { confirmButtonText: '同步所选分集', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  if (await mutation.run(() => props.apply(selected.value))) selected.value = []
}
useSeriesDraftGuard(() => dirty.value, handleSave)
</script>
<template>
  <section class="stack">
    <div class="toolbar">
      <el-button :disabled="!allowed || busy" @click="picker = true"
        >从素材库选择角色、场景与道具</el-button
      ><el-button
        type="primary"
        :disabled="!allowed || busy || !dirty"
        :loading="mutation.busy.value"
        @click="handleSave"
        >保存本剧设定</el-button
      ><router-link to="/entertainment/characters"
        >管理个人角色库 →</router-link
      >
    </div>
    <el-alert
      v-if="mutation.error.value"
      :title="mutation.error.value"
      type="error"
      :closable="false"
    />
    <p class="studio-meta">
      新建分集使用这里确认的版本。以后修改角色形象或声音，需要明确选择同步范围。
    </p>
    <div class="library-grid">
      <StudioAssetCard v-for="asset in assets" :key="asset.id" :asset="asset"
        ><template #actions
          ><el-button
            :disabled="!allowed || busy"
            link
            type="danger"
            @click="assets = assets.filter((item) => item.id !== asset.id)"
            >移出本剧设定</el-button
          ></template
        ></StudioAssetCard
      >
    </div>
    <p v-if="!assets.length" class="empty-cell">
      先从个人库选用本剧角色和场景，也可以到素材中心创建后再选用。
    </p>
    <section class="card stack" aria-label="设定更新范围">
      <h2>同步到已有分集</h2>
      <el-checkbox-group
        v-model="selected"
        class="series-episode-list"
        aria-label="选择同步设定的分集"
        ><label
          v-for="episode in series.episodes"
          :key="episode.id"
          class="series-setting-row"
          ><el-checkbox
            :value="episode.id"
            :disabled="episode.locked || !allowed || busy || dirty"
            >第{{ episode.number }}集 · {{ episode.title }}</el-checkbox
          ><span class="studio-meta">{{
            episode.locked
              ? '已锁定'
              : episode.settingsRevision < series.settingsRevision
                ? '有设定更新'
                : '已沿用当前设定'
          }}</span></label
        ></el-checkbox-group
      >
      <div class="toolbar">
        <el-button
          type="primary"
          :disabled="!allowed || busy || dirty || !selected.length"
          :loading="mutation.busy.value"
          @click="handleApply"
          >同步所选分集</el-button
        ><span v-if="dirty" class="studio-meta"
          >先保存本剧设定，再选择更新范围。</span
        >
      </div>
    </section>
    <StudioAssetPicker
      v-if="picker"
      title="选择本剧共用设定"
      :kinds="['character', 'scene', 'prop']"
      :resolve="select"
      @selected="picker = false"
      @close="picker = false"
    />
  </section>
</template>
