<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/layout/PageHeader.vue'
import StudioBriefFields from './components/project/StudioBriefFields.vue'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import { studioApi } from '@/api/studio/studio-api'
import { seriesApi } from '@/api/studio/series-api'
import { projectBrief } from '@/utils/studio/foundation'
import { createUuid } from '@/utils/uuid'
import type { SeriesBrief } from '@/types/studio/series'
import { useSeriesDraftGuard } from '@/composables/studio/use-series-draft-guard'

/** 新建仅按计划集数建立空白分集草稿，模型调用由后续明确发送触发。 */
const router = useRouter(),
  auth = useAuthStore(),
  mutation = useMutation()
const form = ref<SeriesBrief>({
  ...projectBrief(),
  targetDurationMs: 45000,
  narrativeMode: 'continuous',
  plannedEpisodes: 6,
})
const baseline = ref(JSON.stringify(form.value))
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value)
const abort = new AbortController()
const saved = ref(false)
let attempt = { signature: '', key: '' }
void studioApi
  .creationDefaults(abort.signal)
  .then((defaults) => {
    if (!abort.signal.aborted && !dirty.value) {
      // 默认配置含工程时间基准，整剧表单只采集公开规格字段。
      form.value = {
        ...form.value,
        ...projectBrief({ ...form.value, ...defaults }),
        targetDurationMs: 45000,
      }
      baseline.value = JSON.stringify(form.value)
    }
  })
  .catch((error) => {
    if (!abort.signal.aborted) mutation.error.value = String(error)
  })
async function create() {
  if (!auth.can('studio.projects.write') || !form.value.title.trim()) return
  await mutation.run(async () => {
    const signature = JSON.stringify(form.value)
    if (attempt.signature !== signature)
      attempt = { signature, key: createUuid() }
    const result = await seriesApi.create({
      ...form.value,
      requestKey: attempt.key,
      createEpisodeDrafts: true,
    })
    saved.value = true
    await router.replace({
      path: '/entertainment/series/' + result.id,
      query: { section: 'episodes' },
    })
  })
}
useSeriesDraftGuard(
  () => !saved.value && dirty.value,
  async () => {
    await create()
    return saved.value
  },
)
onScopeDispose(() => abort.abort())
</script>
<template>
  <section class="page stack series-create">
    <PageHeader title="新建系列短剧" />
    <div class="toolbar">
      <router-link to="/entertainment">← 我的作品</router-link>
    </div>
    <form class="form-stack card" @submit.prevent="create">
      <el-alert
        v-if="!auth.can('studio.projects.write')"
        title="当前账号只有查看权限"
        type="info"
        :closable="false"
      />
      <el-alert
        v-if="mutation.error.value"
        :title="mutation.error.value"
        type="error"
        :closable="false"
      />
      <fieldset
        class="series-fieldset"
        :disabled="mutation.busy.value || !auth.can('studio.projects.write')"
      >
        <legend>先确定这部剧的方向</legend>
        <label class="field"
          >故事结构<el-radio-group
            v-model="form.narrativeMode"
            aria-label="故事结构"
            ><el-radio-button value="continuous">连续剧情</el-radio-button
            ><el-radio-button value="anthology"
              >单元故事</el-radio-button
            ></el-radio-group
          ></label
        >
        <p class="studio-meta">
          {{
            form.narrativeMode === 'continuous'
              ? '各集承接同一条主线，编排时一起核对前情和伏笔。'
              : '每集可以独立成篇，共用角色、声音和世界设定。'
          }}
        </p>
        <StudioBriefFields v-model="form" />
        <label class="field"
          >计划集数<el-input-number
            v-model="form.plannedEpisodes"
            :min="1"
            :max="100"
            aria-label="计划集数"
        /></label>
        <p class="studio-meta">
          目标时长按每集计算；集数可调整。创建后先编排故事，确认后再进入单集制作。
        </p>
      </fieldset>
      <div class="dialog-actions">
        <el-button
          type="primary"
          native-type="submit"
          :loading="mutation.busy.value"
          :disabled="!form.title.trim() || !auth.can('studio.projects.write')"
          >创建并编排故事</el-button
        >
      </div>
    </form>
  </section>
</template>
<style scoped>
.series-create {
  max-width: 960px;
}
.series-fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
  display: grid;
  gap: var(--field-gap);
}
.series-fieldset legend {
  padding: 0 0 var(--field-gap);
  font-weight: 600;
}
</style>
