<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watch } from 'vue'
import { productionApi } from '@/api/studio/production-api'
import { studioApi } from '@/api/studio/studio-api'
const props = defineProps<{
  project: string | null
  asset?: string
  job?: string
  kind: 'image' | 'video' | 'audio'
  controls?: boolean
  lazy?: boolean
}>()
const url = ref(''),
  error = ref('')
const emit = defineEmits<{ unavailable: [] }>()
const host = ref<HTMLElement>()
const visible = ref(!props.lazy)
let observer: IntersectionObserver | undefined
onMounted(() => {
  if (!props.lazy || !host.value || !('IntersectionObserver' in window)) {
    visible.value = true
    return
  }
  // 目录只为靠近视口的封面申请短效媒体授权，播放器继续使用 Range 请求。
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        visible.value = true
        observer?.disconnect()
      }
    },
    { rootMargin: '160px' },
  )
  observer.observe(host.value)
})
onScopeDispose(() => observer?.disconnect())
watch(
  () => [props.project, props.asset, props.job, visible.value] as const,
  async ([project, asset, job, ready], _, onCleanup) => {
    let active = true
    const controller = new AbortController()
    onCleanup(() => {
      active = false
      controller.abort()
    })
    url.value = ''
    error.value = ''
    if (!ready) return
    try {
      const next = asset
        ? await studioApi.reference(project, asset, controller.signal)
        : job
          ? project
            ? await studioApi.media(project, job, false, controller.signal)
            : await productionApi.personalMedia(job, controller.signal)
          : ''
      if (active) url.value = next
    } catch (e) {
      if (active) {
        error.value = String(e)
        emit('unavailable')
      }
    }
  },
  { immediate: true },
)
</script>
<template>
  <span
    ref="host"
    class="studio-media"
    :class="{ 'studio-media--preview': controls }"
  >
    <img
      v-if="kind === 'image' && url"
      class="studio-frame"
      :src="url"
      alt="镜头参考画面"
      loading="lazy"
      @error="emit('unavailable')"
    /><video
      v-else-if="kind === 'video' && url"
      class="studio-frame"
      :src="url"
      :controls="controls"
      :muted="!controls"
      playsinline
      preload="metadata"
      @error="emit('unavailable')"
    /><audio v-else-if="url" :src="url" controls preload="none" /><small
      v-else-if="error"
      class="studio-error"
      >{{ error }}</small
    >
  </span>
</template>
<style scoped>
.studio-media {
  display: block;
  min-width: 0;
  max-width: 100%;
}
.studio-media audio {
  display: block;
  width: 100%;
  max-width: 100%;
}
.studio-media .studio-frame {
  max-width: 100%;
}
/* 正式预览保留媒体原始比例；缩略图继续由卡片决定尺寸。 */
.studio-media--preview .studio-frame {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: auto;
  max-height: min(60dvh, 560px);
  object-fit: contain;
}
</style>
