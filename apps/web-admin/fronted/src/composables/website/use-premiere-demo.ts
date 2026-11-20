import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

type Stage = 'script' | 'board' | 'film'
type Playback = 'ready' | 'playing' | 'paused' | 'finished'

/** 官网样片只演示既有素材，从剧本页、分镜到显色；拖动或离开首屏即接管播放。 */
export function usePremiereDemo(
  visible: Readonly<Ref<boolean>>,
  reduced: Readonly<Ref<boolean>>,
) {
  const seam = ref(38)
  const paper = ref(false)
  const playback = ref<Playback>('ready')
  const stage = computed<Stage>(() =>
    paper.value ? 'script' : seam.value > 0 ? 'board' : 'film',
  )
  const scriptEnd = 1600
  const boardEnd = 2450
  const finish = 4800
  let frame = 0
  let elapsed = 0

  function stopFrame() {
    cancelAnimationFrame(frame)
    frame = 0
  }

  function pause() {
    stopFrame()
    if (playback.value === 'playing') playback.value = 'paused'
  }

  function select(value: number, script = false) {
    stopFrame()
    playback.value = 'ready'
    elapsed = 0
    paper.value = script
    seam.value = value
  }

  function chooseStage(next: Stage) {
    select(next === 'film' ? 0 : 100, next === 'script')
  }

  function toggle() {
    if (playback.value === 'playing') return pause()
    if (reduced.value) {
      // 减少动态时，首次点击从剧本开始，之后每次点击直接显示下一阶段。
      if (paper.value) chooseStage('board')
      else if (seam.value === 100) chooseStage('film')
      else chooseStage('script')
      return
    }
    stopFrame()
    const start = performance.now() - elapsed
    playback.value = 'playing'
    function tick(now: number) {
      elapsed = now - start
      paper.value = elapsed < scriptEnd
      const t = Math.min(
        1,
        Math.max(0, (elapsed - boardEnd) / (finish - boardEnd)),
      )
      seam.value = Math.round(100 * (1 - t * t * (3 - 2 * t)))
      if (elapsed < finish) frame = requestAnimationFrame(tick)
      else {
        elapsed = 0
        playback.value = 'finished'
      }
    }
    tick(performance.now())
  }

  watch(reduced, (enabled) => {
    if (enabled) select(38)
  })
  function onVisibility() {
    if (document.hidden) pause()
  }
  watch(visible, (shown) => {
    if (!shown) pause()
  })
  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility)
    if (reduced.value || document.hidden || !visible.value) return
    const start = performance.now()
    function reveal(now: number) {
      const t = Math.min(1, (now - start) / 1350)
      seam.value = Math.round(38 + 32 * (1 - t) ** 3)
      if (t < 1) frame = requestAnimationFrame(reveal)
    }
    frame = requestAnimationFrame(reveal)
  })
  onBeforeUnmount(() => {
    stopFrame()
    document.removeEventListener('visibilitychange', onVisibility)
  })
  return { seam, paper, stage, playback, toggle, select, chooseStage }
}
