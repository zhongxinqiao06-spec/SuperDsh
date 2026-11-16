import { effectScope, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNoticePlans } from '../../fronted/src/composables/workbench/use-notice-plans'
import {
  recordApi,
  type PlanRecord,
} from '../../fronted/src/api/workbench/record-api'
import type { InputForm } from '../../fronted/src/utils/workbench/interaction'

vi.mock('../../fronted/src/api/workbench/record-api', () => ({
  recordApi: { plan: vi.fn() },
}))
const id = 'call_' + 'a'.repeat(64)
const plan: PlanRecord = {
  id,
  sessionId: 'session',
  version: 1,
  title: '创建素材',
  summary: '核对输入',
  state: 'prepared',
  document: { arguments: { name: '合成椰子' } },
}
function form(question = id): InputForm {
  return {
    actionId: 'submit',
    questions: [
      {
        id: question,
        prompt: '核对',
        detail: '',
        approveOptionId: 'o_0',
        multiple: false,
        allowCustom: true,
        options: [
          { id: 'o_0', label: '确认执行', description: '' },
          { id: 'o_1', label: '修改方案', description: '' },
        ],
      },
    ],
  }
}
const answer = (option: string) => ({
  [id]: { optionIds: [option], customText: '', useCustom: false },
})
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}
beforeEach(() => vi.mocked(recordApi.plan).mockReset())

describe('审批只读方案与确认边界', () => {
  it('按会话和收据精确读取，轮询相同notice不重复加载或清空方案', async () => {
    vi.mocked(recordApi.plan).mockResolvedValue({ plan })
    const source = ref(form())
    const scope = effectScope()
    const review = scope.run(() =>
      useNoticePlans({ session: () => 'session', form: () => source.value }),
    )!
    await settle()
    expect(recordApi.plan).toHaveBeenCalledWith(
      'session',
      id,
      expect.any(AbortSignal),
    )
    expect(review.ready(id)).toBe(true)
    expect(review.canSubmit(answer('o_0'))).toBe(true)
    source.value = form()
    await settle()
    expect(recordApi.plan).toHaveBeenCalledTimes(1)
    scope.stop()
  })
  it('读失败与跨会话返回禁止批准，修改与取消不受阻', async () => {
    vi.mocked(recordApi.plan)
      .mockRejectedValueOnce(new Error('没有方案阅读权限'))
      .mockResolvedValueOnce({ plan: { ...plan, sessionId: 'other' } })
      .mockResolvedValue({ plan })
    const scope = effectScope()
    const review = scope.run(() =>
      useNoticePlans({ session: () => 'session', form }),
    )!
    await settle()
    expect(review.canSubmit(answer('o_0'))).toBe(false)
    expect(review.canSubmit(answer('o_1'))).toBe(true)
    await review.reload()
    expect(review.ready(id)).toBe(false)
    expect(review.errors.value[id]).toContain('不匹配')
    await review.reload()
    expect(review.ready(id)).toBe(true)
    scope.stop()
  })
  it('已执行方案不能再次批准；普通模型问题不误走持久方案接口', async () => {
    vi.mocked(recordApi.plan).mockResolvedValue({
      plan: { ...plan, state: 'completed' },
    })
    const source = ref(form())
    const scope = effectScope()
    const review = scope.run(() =>
      useNoticePlans({ session: () => 'session', form: () => source.value }),
    )!
    await settle()
    expect(review.canSubmit(answer('o_0'))).toBe(false)
    source.value = form('ordinary-question')
    await settle()
    expect(review.requiresPlan('ordinary-question')).toBe(false)
    expect(recordApi.plan).toHaveBeenCalledTimes(1)
    scope.stop()
  })
  it('切换会话会取消旧读取，迟到结果不能串到新会话', async () => {
    let resolveOld!: (value: { plan: PlanRecord }) => void
    vi.mocked(recordApi.plan)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValue({ plan: { ...plan, sessionId: 'next' } })
    const session = ref('session')
    const scope = effectScope()
    const review = scope.run(() =>
      useNoticePlans({ session: () => session.value, form }),
    )!
    session.value = 'next'
    await settle()
    resolveOld({ plan })
    await settle()
    expect(review.plans.value[id]?.sessionId).toBe('next')
    scope.stop()
  })
})
