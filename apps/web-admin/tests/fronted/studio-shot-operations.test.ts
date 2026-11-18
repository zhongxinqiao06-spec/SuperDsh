import { describe, expect, it } from 'vitest'
import type {
  Dialogue,
  StudioDocument,
  StudioProject,
} from '../../fronted/src/types/studio/studio'
import {
  duplicateShot,
  removeShot,
  splitShot,
} from '../../fronted/src/utils/studio/storyboard'
import {
  previewAudioTracks,
  shotPlaybackDuration,
} from '../../fronted/src/utils/studio/media-source'

function line(
  id: string,
  start: number,
  audioAssetId: string | null,
): Dialogue {
  return {
    id,
    start,
    audioAssetId,
    audio: null,
    role: 'role',
    text: id,
    voice: '',
    subtitle: null,
    end: null,
    volume: 1,
  }
}

function document(): StudioDocument {
  return {
    script: '',
    assets: ['video', 'voice', 'effect'],
    music: null,
    musicVolume: 1,
    shots: [
      {
        id: 'one',
        action: '完整动作',
        scene: '',
        camera: '',
        framing: '',
        movement: '',
        duration: 10000,
        references: [],
        lines: [],
        candidate: null,
        videoAssetId: 'video',
        trimStart: 2000,
        trimEnd: 9000,
      },
    ],
    soundEffects: [
      {
        id: 'before',
        assetId: 'effect',
        shotId: 'one',
        start: 1000,
        volume: 0.5,
        trimStart: 200,
        trimEnd: 2200,
      },
      {
        id: 'crossing',
        assetId: 'effect',
        shotId: 'one',
        start: 5000,
        volume: 1,
        trimStart: 300,
        trimEnd: 2300,
      },
      {
        id: 'after',
        assetId: 'effect',
        shotId: 'one',
        start: 7000,
        volume: 1,
        trimStart: 0,
        trimEnd: 1000,
      },
      {
        id: 'absolute',
        assetId: 'effect',
        shotId: null,
        start: 1000,
        volume: 1,
        trimStart: 0,
        trimEnd: 1000,
      },
    ],
  }
}

function project(value: StudioDocument): StudioProject {
  return {
    id: 'project',
    title: '',
    revision: 1,
    sessionId: null,
    updated: '',
    proposal: null,
    assets: [],
    history: [],
    jobs: [],
    document: value,
  }
}

function effectPositions(value: StudioDocument) {
  const offsets = new Map<string, number>()
  let position = 0
  for (const shot of value.shots) {
    offsets.set(shot.id, position - shot.trimStart)
    position += shotPlaybackDuration(shot)
  }
  return value.soundEffects?.map((effect) => ({
    id: effect.id,
    position: effect.start + (effect.shotId ? offsets.get(effect.shotId)! : 0),
    trimStart: effect.trimStart,
    trimEnd: effect.trimEnd,
  }))
}

describe('素材镜头的删除、复制与等分', () => {
  it('删除镜头同时清理所属音效，保留其他镜头和全片音效', () => {
    const value = document()
    const other = { ...value.shots[0]!, id: 'other' }
    value.shots.push(other)
    value.soundEffects!.push({
      ...value.soundEffects![0]!,
      id: 'other-effect',
      shotId: 'other',
    })
    removeShot(value, 'one')
    expect(value.shots.map((shot) => shot.id)).toEqual(['other'])
    expect(value.soundEffects!.map((effect) => effect.id)).toEqual([
      'absolute',
      'other-effect',
    ])
    expect(
      value.soundEffects!.every(
        (effect) =>
          !effect.shotId ||
          value.shots.some((shot) => shot.id === effect.shotId),
      ),
    ).toBe(true)
  })

  it('复制镜头和音效分配独立身份，删除副本不会移除原音效', () => {
    const value = document()
    value.shots[0]!.lines = [line('line', 3000, 'voice')]
    const copy = duplicateShot(value, 'one')!
    expect(copy.videoAssetId).toBe('video')
    expect(copy.lines[0]!.id).not.toBe('line')
    const copiedEffects = value.soundEffects!.filter(
      (effect) => effect.shotId === copy.id,
    )
    expect(copiedEffects).toHaveLength(3)
    expect(new Set(value.soundEffects!.map((effect) => effect.id)).size).toBe(7)
    copiedEffects[0]!.start = 2500
    expect(value.soundEffects![0]!.start).toBe(1000)
    removeShot(value, copy.id)
    expect(value.soundEffects).toEqual(document().soundEffects)
  })

  it('等分采用视频的可见源区间，第二半从第一半出点接续', () => {
    const value = document()
    const copy = splitShot(value, 'one')!
    expect(value.shots[0]).toMatchObject({
      videoAssetId: 'video',
      duration: 10000,
      trimStart: 2000,
      trimEnd: 5500,
    })
    expect(copy).toMatchObject({
      videoAssetId: 'video',
      duration: 10000,
      trimStart: 5500,
      trimEnd: 9000,
    })
    expect(value.shots.map(shotPlaybackDuration)).toEqual([3500, 3500])
    expect(value.shots[0]!.trimEnd).toBe(copy.trimStart)
  })

  it('跨分割点的库配音仅续播后半，台词身份不重复，后段台词不被复制', () => {
    const value = document()
    value.shots[0]!.lines = [
      line('crossing-line', 4000, 'voice'),
      line('later-line', 7000, 'voice'),
    ]
    const copy = splitShot(value, 'one', new Map([['voice', 3000]]))!
    expect(value.shots[0]!.lines.map((entry) => entry.id)).toEqual([
      'crossing-line',
    ])
    expect(copy.lines).toHaveLength(2)
    expect(copy.lines[0]).toMatchObject({ start: 4000, audioAssetId: 'voice' })
    expect(copy.lines[0]!.id).not.toBe('crossing-line')
    expect(copy.lines[1]!.id).toBe('later-line')
    const tracks = previewAudioTracks(project(value), 1)
    const continuation = tracks.find((track) => track.id === copy.lines[0]!.id)!
    // 播放器在后半零时刻的实际取样位置为 sourceStart - start，不会从配音头部重播。
    expect(continuation.sourceStart - continuation.start).toBe(1500)
    expect(
      new Set(
        value.shots.flatMap((shot) => shot.lines.map((entry) => entry.id)),
      ).size,
    ).toBe(3)
  })

  it('生成配音跨界或缺少可靠时长时拒绝等分，工程完全保留', () => {
    for (const durations of [
      new Map<string, number>(),
      new Map([['job', 3000]]),
    ]) {
      const value = document()
      value.shots[0]!.lines = [
        { ...line('generated', 4000, null), audio: 'job' },
      ]
      const before = JSON.stringify(value)
      expect(() => splitShot(value, 'one', durations)).toThrow(
        '分割点经过已生成的配音',
      )
      expect(JSON.stringify(value)).toBe(before)
    }
  })

  it('音效开始点、媒体裁剪和跨镜续播不因等分改变', () => {
    const value = document()
    const positions = effectPositions(value)
    const copy = splitShot(value, 'one')!
    expect(effectPositions(value)).toEqual(positions)
    expect(
      value.soundEffects!.find((effect) => effect.id === 'crossing')!.shotId,
    ).toBe('one')
    expect(
      value.soundEffects!.find((effect) => effect.id === 'after')!,
    ).toMatchObject({ shotId: copy.id, start: 7000 })
    expect(value.soundEffects).toHaveLength(4)
    const tracks = previewAudioTracks(project(value), 1)
    expect(
      tracks.find((track) => track.id === 'effect:crossing'),
    ).toMatchObject({ start: -500, sourceStart: 300, duration: 2000 })
  })

  it('旧生成候选仍按原规则拆分时长和移动台词，后半清除画面候选', () => {
    const value = document()
    const source = value.shots[0]!
    source.videoAssetId = null
    source.candidate = 'video-job'
    source.lines = [
      {
        ...line('later', 7000, null),
        audio: 'voice-job',
        subtitleStart: 7200,
        end: 8000,
      },
    ]
    const copy = splitShot(value, 'one')!
    expect(source).toMatchObject({
      duration: 5000,
      trimStart: 0,
      trimEnd: null,
      candidate: 'video-job',
      lines: [],
    })
    expect(copy).toMatchObject({
      duration: 5000,
      trimStart: 0,
      trimEnd: null,
      candidate: null,
    })
    expect(copy.lines[0]).toMatchObject({
      id: 'later',
      start: 2000,
      subtitleStart: 2200,
      end: 3000,
      audio: 'voice-job',
    })
    expect(
      value.soundEffects!.find((effect) => effect.id === 'after'),
    ).toMatchObject({ shotId: copy.id, start: 2000 })
  })

  it('可见区间不足两秒时不产生短片段或修改原稿', () => {
    const value = document()
    value.shots[0]!.trimEnd = 3000
    const before = JSON.stringify(value)
    expect(splitShot(value, 'one')).toBeUndefined()
    expect(JSON.stringify(value)).toBe(before)
  })
})
