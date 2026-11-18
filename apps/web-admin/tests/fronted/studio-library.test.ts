import { describe, expect, it } from 'vitest'
import { applyAssetUse } from '../../fronted/src/utils/studio/asset-use'
import {
  currentProjectAssets,
  hasLibraryUpdates,
  librarySection,
} from '../../fronted/src/utils/studio/library'
import {
  newShot,
  voiceConflict,
  voiceDurations,
} from '../../fronted/src/utils/studio/storyboard'
import type {
  StudioAsset,
  StudioDocument,
} from '../../fronted/src/types/studio/studio'

const asset = (kind: StudioAsset['kind'], id: string = kind): StudioAsset => ({
  id,
  family: 'family-' + id,
  kind,
  name: '测试素材',
  description: '',
  voice: '',
  parent: null,
  project: null,
  fileId: null,
})
function document(): StudioDocument {
  return {
    script: '测试',
    assets: [],
    music: null,
    musicVolume: 0.5,
    scenes: [{ id: 'scene', title: '出发', synopsis: '' }],
    shots: [
      {
        ...newShot(),
        id: 'one',
        candidate: 'job',
        sceneId: 'scene',
        lines: [
          {
            id: 'line',
            role: 'role',
            text: '出发',
            voice: 'original',
            subtitle: null,
            start: 1000,
            end: null,
            audio: 'voice-job',
            volume: 1,
          },
        ],
      },
      {
        ...newShot(),
        id: 'two',
        candidate: 'other',
        sceneAssetId: 'original-scene',
      },
    ],
  }
}

describe('素材与创作引用', () => {
  it('四个菜单按内容分类，不把场景与道具混为一类', () => {
    expect(librarySection('/entertainment/environments')).toBe('scenes')
    expect(librarySection('/entertainment/props')).toBe('props')
    expect(librarySection('/entertainment/characters')).toBe('characters')
    expect(librarySection('/entertainment/library')).toBe('media')
  })
  it('作品素材挑选排除历史未采用版本', () => {
    const old = asset('character', 'old'),
      current = asset('character', 'current')
    expect(
      currentProjectAssets([old, current], [current.id], ['character']),
    ).toEqual([current])
  })
  it('部分采用后以字段更新标记为准，不把本片独有修改标为库内更新', () => {
    const role: StudioAsset = {
      ...asset('character'),
      origin: {
        family: 'personal',
        versionId: 'base',
        currentVersionId: 'latest',
        name: '个人角色',
        hasUpdates: false,
      },
    }
    expect(hasLibraryUpdates(role)).toBe(false)
    role.origin!.hasUpdates = true
    expect(hasLibraryUpdates(role)).toBe(true)
    delete role.origin!.hasUpdates
    expect(hasLibraryUpdates(role)).toBe(true)
    expect(hasLibraryUpdates(asset('character'))).toBe(false)
  })
  it('场次默认场景不会覆盖某镜单独指定的场景、对白与声音', () => {
    const value = document()
    const lines = structuredClone(value.shots[0]!.lines)
    applyAssetUse(value, asset('scene'), { kind: 'scene', sceneId: 'scene' })
    expect(value.scenes![0]!.sceneAssetId).toBe('scene')
    expect(value.shots[1]!.sceneAssetId).toBe('original-scene')
    expect(value.shots[0]!.lines).toEqual(lines)
  })
  it('库内视频只替换指定镜头画面，清除任务采用但保留其他镜与台词', () => {
    const value = document()
    const before = structuredClone(value.shots[1])
    applyAssetUse(value, asset('video'), { kind: 'video', shotId: 'one' })
    expect(value.shots[0]!.videoAssetId).toBe('video')
    expect(value.shots[0]!.candidate).toBeNull()
    expect(value.shots[0]!.lines[0]!.audio).toBe('voice-job')
    expect(value.shots[1]).toEqual(before)
    expect(value.shots[0]!.duration).toBe(5000)
  })
  it('只有明确确认的短片时长才改变目标时长', () => {
    const value = document()
    applyAssetUse(value, asset('video'), {
      kind: 'video',
      shotId: 'one',
      confirmedDuration: 3000,
    })
    expect(value.shots[0]!.duration).toBe(3000)
    expect(value.shots[0]!.lines[0]!.text).toBe('出发')
  })
  it('选用库配音保留角色声音和字幕，实际时长参与冲突提示', () => {
    const value = document()
    const audio = { ...asset('audio'), durationMs: 6000 }
    applyAssetUse(value, audio, {
      kind: 'audio',
      shotId: 'one',
      lineId: 'line',
    })
    const line = value.shots[0]!.lines[0]!
    expect(line.audio).toBeNull()
    expect(line.audioAssetId).toBe(audio.id)
    expect(line.voice).toBe('original')
    expect(
      voiceConflict(line, value.shots[0]!, voiceDurations([], [audio])),
    ).toBe(true)
  })
  it('道具重复选择不会重复引用，错误目标不会加入作品素材', () => {
    const value = document()
    const prop = asset('prop')
    applyAssetUse(value, prop, { kind: 'reference', shotId: 'one' })
    applyAssetUse(value, prop, { kind: 'reference', shotId: 'one' })
    expect(value.shots[0]!.references).toEqual([prop.id])
    expect(value.assets).toEqual([prop.id])
    expect(() =>
      applyAssetUse(value, asset('video'), {
        kind: 'video',
        shotId: 'missing',
      }),
    ).toThrow('镜头已变化')
    expect(value.assets).toEqual([prop.id])
  })
  it('音效绑定稳定镜头身份，重排镜头后时间与来源保持', () => {
    const value = document()
    applyAssetUse(value, asset('audio'), {
      kind: 'effect',
      shotId: 'one',
      id: 'effect',
    })
    value.shots.reverse()
    expect(value.soundEffects![0]).toEqual({
      id: 'effect',
      assetId: 'audio',
      shotId: 'one',
      start: 0,
      volume: 1,
      trimStart: 0,
      trimEnd: null,
    })
    expect(value.shots[1]!.id).toBe('one')
  })
  it('音效保存失败后重复采用不会重复插入，也不重置手工排时', () => {
    const value = document()
    const audio = asset('audio')
    const target = { kind: 'effect' as const, shotId: 'one', id: 'attempt' }
    applyAssetUse(value, audio, target)
    value.soundEffects![0]!.start = 250
    value.soundEffects![0]!.volume = 0.5
    applyAssetUse(value, audio, target)
    expect(value.soundEffects).toHaveLength(1)
    expect(value.soundEffects![0]).toMatchObject({ start: 250, volume: 0.5 })
    expect(value.assets).toEqual([audio.id])
  })
})
