import { describe, expect, it } from 'vitest'
import { answersComplete, inputForm } from '@/utils/workbench/interaction'
import {
  applySessionEvent,
  mergeSessionSnapshot,
  mergeTimeline,
} from '@/utils/workbench/timeline'
import type { SessionEvent, SessionSnapshot } from '@/types/workbench/models'
import runtimeContract from '../../contracts/dsh-runtime.json'

/** 使用固定 DSH 的实际 notice/action 字段验证用户确认与事件恢复。 */
describe('工作台真实协议展示', () => {
  const notice = {
    id: 'notice',
    noticeId: 'notice',
    actions: [
      {
        actionId: 'submit',
        input: {
          uiSchema: {
            component: 'inputRequest',
            questions: [
              {
                id: 'plan',
                prompt: '确认方案？',
                multiple: false,
                allowCustom: true,
                options: [
                  { id: 'o_0', label: '确认执行' },
                  { id: 'o_1', label: '修改方案' },
                ],
              },
            ],
          },
        },
      },
    ],
  }
  it('保留运行时 actionId 与选项身份，未选择不能默认确认', () => {
    const form = inputForm(notice)
    expect(form?.actionId).toBe('submit')
    expect(answersComplete(form, {})).toBe(false)
    expect(
      answersComplete(form, {
        plan: { optionIds: ['o_0'], customText: '', useCustom: false },
      }),
    ).toBe(true)
    expect(
      answersComplete(form, {
        plan: { optionIds: ['model-forged'], customText: '', useCustom: false },
      }),
    ).toBe(false)
    expect(
      answersComplete(form, {
        plan: { optionIds: ['o_0', 'o_1'], customText: '', useCustom: false },
      }),
    ).toBe(false)
    expect(
      answersComplete(form, {
        plan: { optionIds: [], customText: '  ', useCustom: true },
      }),
    ).toBe(false)
  })
  it('迟到修订不覆盖已有时间线，断线间隙不前移游标', () => {
    expect(
      mergeTimeline(
        [{ id: 'a', type: 'message', revision: 3, content: 'new' }],
        [{ id: 'a', type: 'message', revision: 2, content: 'old' }],
      )[0]?.content,
    ).toBe('new')
    const snapshot: SessionSnapshot = {
      eventCursor: 'seq:7',
      timeline: { items: [], nextSeq: null, hasMore: false },
      state: {},
      session: {
        id: 's',
        connectorId: 'c',
        projectId: null,
        runtimeId: 'dsh',
        runtime: 'dsh',
        title: '',
        cwd: '',
        status: 'idle',
        pinned: false,
        archived: false,
        takeover: false,
        unread: false,
        updatedSeq: 0,
        agentDefinition: null,
      },
      notices: [],
      approvals: [],
      effectiveCapabilities: {},
    }
    const event = {
      protocolVersion: runtimeContract.protocolVersion,
      eventId: 'e',
      sequence: 9,
      cursor: 'seq:9',
      type: 'timeline.item_created',
      sessionId: 's',
      payload: { item: { id: 'a', type: 'message' } },
    } as SessionEvent
    expect(applySessionEvent(snapshot, event)).toBe('refetch')
    expect(snapshot.eventCursor).toBe('seq:7')
    expect(
      applySessionEvent(snapshot, { ...event, sequence: 7, cursor: 'seq:7' }),
    ).toBe('duplicate')
    expect(
      applySessionEvent(snapshot, { ...event, sequence: 8, cursor: 'seq:8' }),
    ).toBe('applied')
    expect(snapshot.timeline.items).toHaveLength(1)
    expect(applySessionEvent(snapshot, { ...event, protocolVersion: '' })).toBe(
      'refetch',
    )
    expect(
      applySessionEvent(snapshot, {
        ...event,
        type: 'runtime.capability.updated',
      }),
    ).toBe('refetch')
    for (const type of ['runtime.notice.updated', 'notice.upsert']) {
      expect(applySessionEvent(snapshot, { ...event, type })).toBe('refetch')
      expect(snapshot.eventCursor).toBe('seq:8')
    }
    snapshot.timeline.items = [
      { id: 'old', type: 'message', orderSeq: 1 },
      { id: 'new', type: 'message', orderSeq: 5 },
    ]
    const incoming: SessionSnapshot = {
      ...snapshot,
      eventCursor: 'seq:9',
      timeline: {
        items: [{ id: 'new', type: 'message', orderSeq: 5, revision: 2 }],
        hasMore: true,
        nextSeq: 9,
      },
    }
    const restored = mergeSessionSnapshot(snapshot, incoming)
    expect(restored.timeline.items.map((item) => item.id)).toEqual([
      'old',
      'new',
    ])
    expect(restored.timeline.items[1]?.revision).toBe(2)
    expect(restored.timeline.hasMore).toBe(false)
    expect(restored.timeline.nextSeq).toBe(9)
    expect(mergeSessionSnapshot(restored, snapshot)).toBe(restored)
    const distant: SessionSnapshot = {
      ...incoming,
      eventCursor: 'seq:20',
      timeline: {
        items: [{ id: 'distant', type: 'message', orderSeq: 20 }],
        hasMore: true,
        nextSeq: 20,
      },
    }
    expect(mergeSessionSnapshot(restored, distant)).toBe(distant)
    // 权威完整快照可以删除条目，不能无条件合并已失效的旧内容。
    expect(
      mergeSessionSnapshot(restored, {
        ...incoming,
        timeline: { ...incoming.timeline, hasMore: false },
      }).timeline.items.map((item) => item.id),
    ).toEqual(['new'])
  })
})
