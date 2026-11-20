<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/base/AppIcon.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ScrollPanel from '@/components/layout/ScrollPanel.vue'
import { useWorkCreation } from '@/composables/studio/use-work-creation'
import { useSeriesDraftGuard } from '@/composables/studio/use-series-draft-guard'
import StudioBriefFields from './components/project/StudioBriefFields.vue'

/** 分镜和整剧共用创建页，提交成功后直接打开该作品的故事或分集编辑。 */
const props = defineProps<{ mode: 'storyboard' | 'series' }>()
const series = props.mode === 'series'
const title = series ? '新建系列短剧' : '新建分镜作品'
const router = useRouter()
const { form, defaults, dirty, canCreate, mutation, create } = useWorkCreation(
  props.mode,
)
const { busy, error } = mutation
const errorBlock = ref<HTMLElement>()
watch(
  error,
  (message) => {
    if (message) errorBlock.value?.scrollIntoView({ block: 'nearest' })
  },
  { flush: 'post' },
)

async function submit() {
  const id = await create()
  if (id)
    await router.replace({
      path:
        (series ? '/entertainment/series/' : '/entertainment/') +
        encodeURIComponent(id),
      query: { section: series ? 'episodes' : 'script' },
    })
}

useSeriesDraftGuard(
  () => dirty.value,
  undefined,
  () => busy.value,
)
</script>

<template>
  <section class="page studio-create-page">
    <div class="create-heading">
      <router-link to="/entertainment"
        ><AppIcon name="arrow-left" />返回创作中心</router-link
      >
      <PageHeader :title="title" />
    </div>
    <ScrollPanel :label="title" class="create-panel">
      <div v-if="error" ref="errorBlock" class="create-error">
        <el-alert :title="error" type="error" :closable="false" />
      </div>
      <ResourceStatus
        :loading="defaults.loading.value"
        :error="defaults.error.value"
        :has-data="Boolean(defaults.data.value)"
        @retry="defaults.reload"
      />
      <form
        v-if="defaults.data.value"
        id="studio-create-form"
        :aria-label="title"
        class="form-stack"
        @submit.prevent="submit"
      >
        <h2>故事设定</h2>
        <StudioBriefFields
          v-model="form"
          :disabled="busy || !canCreate"
          :per-episode="series"
        >
          <template v-if="series" #after-title>
            <div class="field">
              <span>故事结构</span>
              <el-radio-group
                v-model="form.narrativeMode"
                :disabled="busy"
                aria-label="故事结构"
              >
                <el-radio-button value="continuous">连续剧情</el-radio-button>
                <el-radio-button value="anthology">单元故事</el-radio-button>
              </el-radio-group>
              <small>{{
                form.narrativeMode === 'continuous'
                  ? '各集承接同一条主线，编排时一起核对前情和伏笔。'
                  : '每集可以独立成篇，共用角色、声音和世界设定。'
              }}</small>
            </div>
          </template>
          <template #after-story>
            <label v-if="series" class="field"
              >初始集数
              <el-input-number
                v-model="form.plannedEpisodes"
                :disabled="busy"
                :min="1"
                :max="100"
                aria-label="初始集数"
              />
              <small
                >先建立这些分集草稿，之后可在「故事与分集」添加新集。</small
              >
            </label>
            <h2 class="spec-heading">制作规格</h2>
          </template>
        </StudioBriefFields>
      </form>
      <template #footer>
        <div class="dialog-actions">
          <el-button :disabled="busy" @click="router.push('/entertainment')"
            >取消</el-button
          >
          <el-button
            form="studio-create-form"
            native-type="submit"
            type="primary"
            :loading="busy"
            :disabled="!canCreate || !defaults.data.value || !form.title.trim()"
            >{{ series ? '创建并编排故事' : '创建并编辑故事' }}</el-button
          >
        </div>
      </template>
    </ScrollPanel>
  </section>
</template>

<style scoped>
.studio-create-page {
  height: 100%;
  max-width: 960px;
  min-height: 0;
  gap: var(--field-gap);
}
.create-heading {
  display: grid;
  gap: var(--control-gap);
}
.create-heading a {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: var(--control-gap);
  color: var(--brand-ink);
}
.create-panel {
  flex: 0 1 auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--card);
  box-shadow: var(--shadow-card);
}
.create-panel :deep(.scroll-panel__body) {
  padding: var(--panel-padding);
}
.create-panel h2 {
  margin: 0;
  font-size: var(--font-size-section);
  line-height: var(--line-height-section);
}
.create-panel small {
  color: var(--muted-foreground);
}
.create-error {
  margin-block-end: var(--field-gap);
  overflow-wrap: anywhere;
}
.spec-heading {
  border-top: 1px solid var(--border);
  padding-block-start: var(--field-gap);
}
</style>
