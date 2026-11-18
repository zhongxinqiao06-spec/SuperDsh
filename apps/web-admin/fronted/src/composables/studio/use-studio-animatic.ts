import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import { studioApi } from '@/api/studio/studio-api'
import type { StudioProject } from '@/types/studio/studio'
import {
  dialogueDuration,
  previewAudioTracks,
  shotPlaybackDuration,
} from '@/utils/studio/media-source'

/** 本地预演协调当前采用画面、参考图和配音；只读工程，不提交渲染任务。 */
export function useStudioAnimatic(project: Ref<StudioProject>) {
  const playing = ref(false),
    loading = ref(false),
    index = ref(0),
    elapsed = ref(0),
    error = ref('')
  const audio = new Map<string, HTMLAudioElement>()
  const durations = ref<Record<string, number>>({})
  const videoUrl = ref('')
  const videoPlayer = ref<HTMLVideoElement>()
  const shot = computed(() => project.value.document.shots[index.value])
  const tracks = computed(() => previewAudioTracks(project.value, index.value))
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
      shot.value ? shotPlaybackDuration(shot.value) : 0,
      ...(shot.value?.lines.map(
        (l) =>
          l.start -
          (shot.value?.trimStart ?? 0) +
          (dialogueDuration(project.value, l) || durations.value[l.id] || 0),
      ) ?? []),
    ),
  )
  const currentLines = computed(
    () =>
      shot.value?.lines.filter(
        (l) =>
          elapsed.value >=
            Math.max(0, (l.subtitleStart ?? l.start) - shot.value!.trimStart) &&
          elapsed.value <
            (l.end ??
              l.start +
                (dialogueDuration(project.value, l) ||
                  durations.value[l.id] ||
                  shot.value!.duration)) -
              shot.value!.trimStart,
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
    videoPlayer.value?.pause()
  }
  function releaseAudio() {
    audio.forEach((item) => {
      item.pause()
      item.onloadedmetadata = null
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
    durations.value = {}
    videoUrl.value = ''
    elapsed.value = 0
    error.value = ''
    loading.value = true
    try {
      const selectedShot = shot.value
      await Promise.all([
        ...tracks.value.map(async (track) => {
          const url = track.assetId
            ? await studioApi.reference(project.value.id, track.assetId, signal)
            : await studioApi.media(
                project.value.id,
                track.jobId!,
                false,
                signal,
              )
          if (!signal.aborted) {
            const player = new Audio(url)
            player.preload = 'metadata'
            player.loop = track.loop
            player.onloadedmetadata = () => {
              if (!signal.aborted && Number.isFinite(player.duration))
                durations.value = {
                  ...durations.value,
                  [track.id]: player.duration * 1000,
                }
            }
            audio.set(track.id, player)
          }
        }),
        (async () => {
          const url = selectedShot?.videoAssetId
            ? await studioApi.reference(
                project.value.id,
                selectedShot.videoAssetId,
                signal,
              )
            : selectedShot?.candidate
              ? await studioApi.media(
                  project.value.id,
                  selectedShot.candidate,
                  false,
                  signal,
                )
              : ''
          if (!signal.aborted) videoUrl.value = url
        })(),
      ])
    } catch (cause) {
      if (!signal.aborted) error.value = String(cause)
    } finally {
      if (!signal.aborted) loading.value = false
    }
  }
  watch(
    () => [
      index.value,
      project.value.revision,
      JSON.stringify({
        shot: shot.value?.id,
        candidate: shot.value?.candidate,
        video: shot.value?.videoAssetId,
        trimStart: shot.value?.trimStart,
        trimEnd: shot.value?.trimEnd,
        lines: shot.value?.lines.map((line) => [
          line.id,
          line.audio,
          line.audioAssetId,
          line.start,
          line.end,
          line.volume,
        ]),
        soundEffects: project.value.document.soundEffects,
        music: project.value.document.music,
        musicVolume: project.value.document.musicVolume,
      }),
    ],
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
    await nextTick()
    if (ticket !== generation || disposed || !shot.value) return
    if (elapsed.value >= length.value) elapsed.value = 0
    error.value = ''
    playing.value = true
    if (videoPlayer.value) {
      videoPlayer.value.currentTime =
        (shot.value.trimStart + elapsed.value) / 1000
      void videoPlayer.value.play().catch(() => {
        if (ticket !== generation || disposed) return
        error.value = '画面播放失败，请重新点击播放，或检查所选媒体是否可访问。'
        pause()
      })
    }
    let previous = performance.now()
    const started = new Set<string>()
    timer = setInterval(() => {
      const now = performance.now()
      elapsed.value += now - previous
      previous = now
      for (const track of tracks.value) {
        const duration = track.loop
          ? Infinity
          : (track.duration ??
            (durations.value[track.id]
              ? Math.max(0, durations.value[track.id]! - track.sourceStart)
              : Math.max(0, length.value - track.start)))
        const player = audio.get(track.id)
        if (!player) continue
        if (elapsed.value >= track.start + duration) {
          player.pause()
          continue
        }
        if (
          elapsed.value >= Math.max(0, track.start) &&
          !started.has(track.id)
        ) {
          started.add(track.id)
          const position = Math.max(
            0,
            (track.sourceStart + elapsed.value - track.start) / 1000,
          )
          player.currentTime =
            track.loop &&
            Number.isFinite(player.duration) &&
            player.duration > 0
              ? position % player.duration
              : position
          player.volume = Math.max(0, Math.min(1, track.volume))
          void player.play().catch(() => {
            if (ticket !== generation || disposed) return
            error.value =
              '浏览器阻止了配音播放，请先在镜头中试听音频，再重新开始。'
            pause()
          })
        }
      }
      if (videoPlayer.value && shot.value) {
        const clipEnd = shot.value.trimEnd ?? shot.value.duration
        if (videoPlayer.value.currentTime * 1000 >= clipEnd)
          videoPlayer.value.pause()
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
    videoUrl,
    videoPlayer,
    length,
    currentLines,
    play,
    pause,
  }
}
