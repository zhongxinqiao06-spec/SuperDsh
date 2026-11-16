import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import { studioApi } from '@/api/studio/studio-api'
import type { StudioProject } from '@/types/studio/studio'

/** 预演只协调当前工程的图片和音频；不写工程、不提交渲染任务。 */
export function useStudioAnimatic(project: Ref<StudioProject>) {
  const playing = ref(false),
    loading = ref(false),
    index = ref(0),
    elapsed = ref(0),
    error = ref('')
  const audio = new Map<string, HTMLAudioElement>()
  const shot = computed(() => project.value.document.shots[index.value])
  const picture = computed(
    () =>
      shot.value?.references
        .map((id) => project.value.assets.find((a) => a.id === id))
        .find((a) => a?.kind === 'image' && a.fileId) ??
      shot.value?.references
        .map((id) => project.value.assets.find((a) => a.id === id))
        .find((a) => a?.fileId),
  )
  const length = computed(() =>
    Math.max(
      shot.value?.duration ?? 0,
      ...(shot.value?.lines.map(
        (l) =>
          l.start +
          (project.value.jobs.find((j) => j.id === l.audio)?.duration ?? 0),
      ) ?? []),
    ),
  )
  const currentLines = computed(
    () =>
      shot.value?.lines.filter(
        (l) =>
          elapsed.value >= l.start &&
          elapsed.value <
            (l.end ??
              l.start +
                (project.value.jobs.find((j) => j.id === l.audio)?.duration ??
                  shot.value!.duration)),
      ) ?? [],
  )
  let timer: ReturnType<typeof setInterval> | undefined
  let controller: AbortController | undefined
  let loaded: Promise<void> = Promise.resolve()
  let generation = 0,
    disposed = false
  function pause() {
    generation++
    playing.value = false
    clearInterval(timer)
    audio.forEach((item) => item.pause())
  }
  function releaseAudio() {
    audio.forEach((item) => {
      item.pause()
      item.removeAttribute('src')
      item.load()
    })
    audio.clear()
  }
  async function load() {
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    releaseAudio()
    elapsed.value = 0
    loading.value = true
    try {
      await Promise.all(
        (shot.value?.lines ?? [])
          .filter((l) => l.audio)
          .map(async (line) => {
            const url = await studioApi.media(
              project.value.id,
              line.audio!,
              false,
              signal,
            )
            if (!signal.aborted) audio.set(line.id, new Audio(url))
          }),
      )
    } catch (cause) {
      if (!signal.aborted) error.value = String(cause)
    } finally {
      if (!signal.aborted) loading.value = false
    }
  }
  watch(
    () => [index.value, project.value.revision],
    () => {
      pause()
      if (index.value >= project.value.document.shots.length)
        index.value = Math.max(0, project.value.document.shots.length - 1)
      loaded = load()
    },
    { immediate: true },
  )
  async function play() {
    if (!shot.value || playing.value || disposed) return
    const ticket = ++generation
    await loaded
    if (ticket !== generation || disposed || !shot.value) return
    if (elapsed.value >= length.value) elapsed.value = 0
    error.value = ''
    playing.value = true
    let previous = performance.now()
    const started = new Set<string>()
    timer = setInterval(() => {
      const now = performance.now()
      elapsed.value += now - previous
      previous = now
      for (const line of shot.value?.lines ?? []) {
        const duration =
          project.value.jobs.find((j) => j.id === line.audio)?.duration ?? 0
        if (
          elapsed.value >= line.start &&
          elapsed.value < line.start + duration &&
          audio.has(line.id) &&
          !started.has(line.id)
        ) {
          started.add(line.id)
          const player = audio.get(line.id)!
          player.currentTime = Math.max(0, (elapsed.value - line.start) / 1000)
          player.volume = Math.min(1, line.volume)
          void player.play().catch(() => {
            error.value =
              '浏览器阻止了配音播放，请先在镜头中试听音频，再重新开始。'
            pause()
          })
        }
      }
      if (elapsed.value >= length.value) {
        pause()
        if (index.value + 1 < project.value.document.shots.length) {
          index.value++
          void nextTick().then(() => {
            if (!disposed) void play()
          })
        }
      }
    }, 80)
  }
  onScopeDispose(() => {
    disposed = true
    pause()
    controller?.abort()
    releaseAudio()
  })
  return {
    playing,
    loading,
    index,
    elapsed,
    error,
    shot,
    picture,
    length,
    currentLines,
    play,
    pause,
  }
}
