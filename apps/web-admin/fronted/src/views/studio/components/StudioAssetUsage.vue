<script setup lang="ts">
import { ref, watch } from 'vue'
import { useResource } from '@/composables/use-resource'
import { studioApi } from '@/api/studio/studio-api'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
const props = defineProps<{ asset: string; project: string | null }>()
const page = ref(1),
  size = ref(10)
const { data, loading, error, reload } = useResource((signal) =>
  studioApi.usage(props.asset, props.project, page.value, size.value, signal),
)
watch([page, size], () => void reload())
</script>
<template>
  <section class="studio-usage" aria-label="素材使用位置">
    <h3>使用位置</h3>
    <ResourceStatus
      :loading="loading"
      :error="error"
      :has-data="!!data?.total"
      @retry="reload"
    />
    <p v-if="!loading && !error && !data?.total">尚未被作品引用。</p>
    <div v-for="work in data?.items" :key="work.project">
      <router-link
        :to="{
          path: '/entertainment/' + work.project,
          query: { section: 'cast', asset },
        }"
        >{{ work.title }}</router-link
      >
      <span v-if="work.music"> · 背景音乐已采用</span>
      <span
        v-if="
          !work.shots.length &&
          !work.music &&
          !work.scenes?.length &&
          !work.soundEffects?.length
        "
      >
        · 已关联，尚未用于镜头</span
      >
      <ul v-if="work.scenes?.length">
        <li v-for="scene in work.scenes" :key="scene.id">
          <router-link
            :to="{
              path: '/entertainment/' + work.project,
              query: { section: 'script', scene: scene.id },
            }"
            >场次 · {{ scene.title }}</router-link
          >
        </li>
      </ul>
      <ul v-if="work.soundEffects?.length">
        <li v-for="effect in work.soundEffects" :key="effect.id">
          <router-link
            :to="{
              path: '/entertainment/' + work.project,
              query: { section: 'edit', shot: effect.shotId ?? undefined },
            }"
            >查看音效位置</router-link
          >
        </li>
      </ul>
      <ul v-if="work.shots.length">
        <li v-for="shot in work.shots" :key="shot.id">
          <router-link
            :to="{
              path: '/entertainment/' + work.project,
              query: { section: 'storyboard', shot: shot.id },
            }"
            >镜 {{ shot.number
            }}{{ shot.adopted ? ' · 已采用' : '' }}</router-link
          >
        </li>
      </ul>
    </div>
    <ManagementPagination
      v-if="(data?.total ?? 0) > 10"
      v-model:current-page="page"
      v-model:page-size="size"
      :total="data?.total ?? 0"
      :loading="loading"
      :page-sizes="[10, 20, 50]"
    />
  </section>
</template>
<style scoped>
.studio-usage {
  border-top: 1px solid var(--border);
  margin-top: 14px;
  padding-top: 8px;
}
.studio-usage h3 {
  margin-block: 4px 8px;
}
.studio-usage ul {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 0;
  margin: 4px 0 10px;
  list-style: none;
}
.studio-usage span {
  color: var(--muted-foreground);
}
</style>
