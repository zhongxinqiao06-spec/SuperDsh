import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStudioAnimatic } from '../../fronted/src/composables/studio/use-studio-animatic'
import { studioApi } from '../../fronted/src/api/studio/studio-api'
import { newShot } from '../../fronted/src/utils/studio/storyboard'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

vi.mock('../../fronted/src/api/studio/studio-api', () => ({
  studioApi: { media: vi.fn() },
}))

/** 预演协调音轨、暂停和离开清理，始终不修改工程或提交任务。 */
describe('静态分镜预演', () => {
  const players: {
    currentTime: number
    volume: number
    play: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
  }[] = []
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'performance'],
    })
    players.length = 0
    vi.mocked(studioApi.media).mockResolvedValue('/authorized-audio')
    vi.stubGlobal(
      'Audio',
      class {
        currentTime = 0
        volume = 1
        play = vi.fn().mockResolvedValue(undefined)
        pause = vi.fn()
        load = vi.fn()
        removeAttribute = vi.fn()
        constructor() {
          players.push(this)
        }
      },
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  function setup() {
    const value = ref<StudioProject>({
      id: 'project',
      title: '预演',
      revision: 1,
      sessionId: null,
      updated: '',
      proposal: null,
      assets: [],
      history: [],
      document: {
        script: '出发',
        assets: [],
        music: null,
        musicVolume: 1,
        shots: [
          {
            ...newShot(),
            id: 'one',
            duration: 4000,
            lines: [
              {
                id: 'line',
                role: 'role',
                text: '出发',
                voice: '',
                start: 1000,
                end: null,
                audio: 'sound',
                subtitle: null,
                volume: 0.5,
              },
            ],
          },
          { ...newShot(), id: 'two', duration: 2000 },
        ],
      },
      jobs: [
        {
          id: 'sound',
          subject: 'line',
          kind: 'speech',
          revision: 1,
          state: 'ready',
          error: null,
          duration: 2000,
        },
      ],
    })
    const scope = effectScope()
    const state = scope.run(() => useStudioAnimatic(value))!
    return { value, state, scope }
  }
  it('按台词起点播放，暂停后续播，不改变工程', async () => {
    const { value, state, scope } = setup()
    const original = JSON.stringify(value.value)
    try {
      await state.play()
      await vi.advanceTimersByTimeAsync(800)
      expect(players[0]!.play).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(400)
      expect(players[0]!.play).toHaveBeenCalledTimes(1)
      expect(players[0]!.volume).toBe(0.5)
      state.pause()
      const paused = state.elapsed.value
      await vi.advanceTimersByTimeAsync(500)
      expect(state.elapsed.value).toBe(paused)
      await state.play()
      await vi.advanceTimersByTimeAsync(160)
      expect(players[0]!.play).toHaveBeenCalledTimes(2)
      expect(players[0]!.currentTime).toBeGreaterThan(0)
      expect(JSON.stringify(value.value)).toBe(original)
    } finally {
      scope.stop()
    }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('重载工程立即停止旧音轨，下一镜不延续旧台词', async () => {
    const { value, state, scope } = setup()
    try {
      await state.play()
      value.value.revision++
      await nextTick()
      expect(state.playing.value).toBe(false)
      state.index.value = 1
      await nextTick()
      await state.play()
      expect(state.currentLines.value).toEqual([])
      expect(state.shot.value?.id).toBe('two')
    } finally {
      scope.stop()
    }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('离开时取消未完成的音频授权，迟到结果不能重新播放', async () => {
    let finish!: (url: string) => void
    vi.mocked(studioApi.media).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const { state, scope } = setup()
    const pending = state.play()
    scope.stop()
    finish('/late-audio')
    await pending
    expect(players).toHaveLength(0)
    expect(state.playing.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
