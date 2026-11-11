import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { conversationApi } from '@/api/workbench/conversation-api'
import { sessionController } from '@/store/session-controller'
import { useSessionLifecycle } from '@/composables/workbench/use-session-lifecycle'
import type {
  SessionSnapshot,
  WorkspaceSession,
} from '@/types/workbench/models'

const confirm = vi.hoisted(() => vi.fn<() => Promise<void>>())
vi.mock('element-plus', () => ({ ElMessageBox: { confirm } }))
vi.mock('@/api/workbench/conversation-api', () => ({
  conversationApi: { remove: vi.fn(), interrupt: vi.fn() },
}))

/** 合成会话只验证交互状态机；真实引擎验收不依赖此替身。 */
function fixture() {
  const row: WorkspaceSession = {
    id: 'synthetic',
    connectorId: 'connector',
    projectId: null,
    runtimeId: 'dsh',
    runtime: 'dsh',
    title: '待删除会话',
    cwd: '/synthetic',
    status: 'running',
    pinned: false,
    archived: false,
    takeover: true,
    unread: false,
    updatedSeq: 1,
    agentDefinition: null,
  }
  const abort = new AbortController()
  const options = {
    selected: ref(row.id),
    snapshot: ref<SessionSnapshot | null>({
      session: row,
      state: {},
      timeline: { items: [], nextSeq: null, hasMore: false },
      notices: [],
      approvals: [],
      effectiveCapabilities: {},
      eventCursor: '',
    }),
    sessions: ref([row]),
    signal: abort.signal,
    run: async (action: () => Promise<void>) => action(),
    refresh: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    fresh: vi.fn(),
    removeDraft: vi.fn(),
    report: vi.fn(),
  }
  return { row, abort, options, lifecycle: useSessionLifecycle(options) }
}

beforeEach(() => {
  vi.useFakeTimers()
  confirm.mockResolvedValue()
  vi.mocked(conversationApi.remove).mockResolvedValue({ deleted: true })
  vi.mocked(conversationApi.interrupt).mockResolvedValue({ accepted: true })
})
afterEach(() => vi.useRealTimers())

describe('历史会话删除', () => {
  it('取消确认或服务端拒绝时保留会话与草稿', async () => {
    const { lifecycle, row, options } = fixture()
    confirm.mockRejectedValueOnce('cancel')
    await lifecycle.remove(row)
    expect(conversationApi.remove).not.toHaveBeenCalled()
    vi.mocked(conversationApi.remove).mockRejectedValueOnce(
      new Error('任务尚未停止'),
    )
    await expect(lifecycle.remove(row)).rejects.toThrow('任务尚未停止')
    expect(options.sessions.value).toHaveLength(1)
    expect(options.fresh).not.toHaveBeenCalled()
    expect(options.removeDraft).not.toHaveBeenCalled()
  })

  it('成功后清理当前草稿、返回新对话并刷新列表', async () => {
    const { lifecycle, row, options } = fixture()
    await lifecycle.remove(row)
    expect(conversationApi.remove).toHaveBeenCalledWith(row.id)
    expect(options.sessions.value).toEqual([])
    expect(options.fresh).toHaveBeenCalledOnce()
    expect(options.removeDraft).toHaveBeenCalledWith(row.id)
    expect(options.reload).toHaveBeenCalledOnce()
  })

  it('等待删除期间换号不能清理新账号状态', async () => {
    const { lifecycle, row, options } = fixture()
    vi.mocked(conversationApi.remove).mockImplementationOnce(async () => {
      sessionController.clear()
      return { deleted: true }
    })
    await lifecycle.remove(row)
    expect(options.sessions.value).toHaveLength(1)
    expect(options.fresh).not.toHaveBeenCalled()
  })
})

describe('终止确认', () => {
  it('只发一次中断，真实状态变为空闲后才完成', async () => {
    const { lifecycle, options } = fixture()
    options.refresh
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        options.snapshot.value!.session.status = 'idle'
      })
    const pending = lifecycle.interrupt()
    await Promise.resolve()
    expect(lifecycle.interrupting.value).toBe(true)
    await lifecycle.interrupt()
    await vi.advanceTimersByTimeAsync(500)
    await pending
    expect(conversationApi.interrupt).toHaveBeenCalledTimes(1)
    expect(options.refresh).toHaveBeenCalledTimes(2)
    expect(options.reload).toHaveBeenCalledOnce()
    expect(lifecycle.interrupting.value).toBe(false)
  })

  it('状态一直运行则有界超时，不伪造停止也不重发中断', async () => {
    const { lifecycle, options } = fixture()
    const checked = expect(lifecycle.interrupt()).rejects.toThrow(
      '引擎尚未确认停止',
    )
    await vi.advanceTimersByTimeAsync(15000)
    await checked
    expect(options.snapshot.value!.session.status).toBe('running')
    expect(conversationApi.interrupt).toHaveBeenCalledTimes(1)
    expect(lifecycle.interrupting.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('卸载立即结束等待并释放定时器', async () => {
    const { lifecycle, abort, options } = fixture()
    const pending = lifecycle.interrupt()
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    await pending
    expect(vi.getTimerCount()).toBe(0)
    expect(options.reload).not.toHaveBeenCalled()
  })

  it('缺失诊断显示可操作提示，不宣称成功终止', async () => {
    const { lifecycle, options } = fixture()
    vi.mocked(conversationApi.interrupt).mockResolvedValueOnce({
      accepted: false,
      missing: true,
    })
    options.refresh.mockImplementationOnce(async () => {
      options.snapshot.value!.session.status = 'error'
    })
    await lifecycle.interrupt()
    expect(options.report).toHaveBeenCalledWith(
      expect.stringContaining('未找到此会话'),
    )
  })
})
