import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { useRuntimeSelections } from '@/composables/workbench/use-runtime-selections'
import { conversationApi } from '@/api/workbench/conversation-api'
import * as selection from '@/utils/workbench/catalog'
import type { RuntimeCatalog, SessionSnapshot } from '@/types/workbench/models'
import type { WorkspaceDraft } from '@/store/modules/draft-store'

const catalog: RuntimeCatalog = {
  models: [
    {
      id: 'model-logical',
      displayName: '合成模型',
      enabled: true,
      reasoningItems: [
        {
          id: 'light',
          selectionId: 'opaque-light',
          default: true,
          enabled: true,
        },
        { id: 'deep', selectionId: 'opaque-deep', enabled: true },
        {
          id: 'blocked',
          selectionId: 'opaque-blocked',
          metadata: { enabled: false, disabledReason: '未配置' },
        },
      ],
      metadata: {},
    },
    {
      id: 'disabled-model',
      selectionId: 'opaque-disabled',
      enabled: false,
      reasoningItems: [],
      metadata: {},
    },
  ],
  permissions: [
    {
      id: 'read',
      selectionId: 'opaque-read',
      enabled: true,
      metadata: { preset: 'read-only' },
    },
  ],
}

describe('真实旧目录选择规则差分', () => {
  it('推理默认/停用/已有停用选择回显/权限标识与旧函数一致', () => {
    const fixtures = [
      {
        operation: 'selectionIdForModelCatalog',
        arguments: [catalog, 'model-logical', ''],
        actual: selection.selectionIdForModelCatalog(
          catalog,
          'model-logical',
          '',
        ),
      },
      {
        operation: 'selectionIdForModelCatalog',
        arguments: [catalog, 'model-logical', 'deep'],
        actual: selection.selectionIdForModelCatalog(
          catalog,
          'model-logical',
          'deep',
        ),
      },
      {
        operation: 'selectionIdForModelCatalog',
        arguments: [catalog, 'model-logical', 'blocked'],
        actual: selection.selectionIdForModelCatalog(
          catalog,
          'model-logical',
          'blocked',
        ),
      },
      {
        operation: 'modelIdsForSelectionId',
        arguments: [catalog, 'opaque-disabled', true],
        actual: selection.modelIdsForSelectionId(
          catalog,
          'opaque-disabled',
          true,
        ),
      },
      {
        operation: 'modelIdsForSelectionId',
        arguments: [catalog, 'opaque-disabled', false],
        actual: selection.modelIdsForSelectionId(
          catalog,
          'opaque-disabled',
          false,
        ),
      },
      {
        operation: 'selectionIdForPermissionCatalog',
        arguments: [catalog, 'read'],
        actual: selection.selectionIdForPermissionCatalog(catalog, 'read'),
      },
    ]
    const process = spawnSync(
      globalThis.process.execPath,
      [
        resolve(
          globalThis.process.cwd(),
          'apps/web-admin/tests/parity/runtime-oracle.ts',
        ),
      ],
      {
        encoding: 'utf8',
        input: JSON.stringify(
          fixtures.map(({ operation, arguments: args }) => ({
            kind: 'selection',
            operation,
            arguments: args,
          })),
        ),
        timeout: 30_000,
      },
    )
    expect(process.status, process.stderr).toBe(0)
    expect(fixtures.map((item) => item.actual)).toEqual(
      JSON.parse(process.stdout),
    )
  })
})

function state(existing = false) {
  const draft = ref<WorkspaceDraft>({
    text: '',
    files: [],
    deviceId: 'test',
    modelId: '',
  })
  const selected = ref(existing ? 'synthetic-session' : '')
  const snapshot = ref<SessionSnapshot | null>(
    existing
      ? {
          session: {
            id: selected.value,
            connectorId: 'test',
            connectorStatus: 'online',
            projectId: null,
            runtime: 'dsh',
            runtimeId: 'dsh',
            title: '测试',
            cwd: '',
            status: 'idle',
            pinned: false,
            archived: false,
            takeover: true,
            unread: false,
            updatedSeq: 0,
            agentDefinition: null,
          },
          state: {
            selections: { model: 'opaque-light', permission: 'opaque-read' },
          },
          timeline: { items: [], hasMore: false, nextSeq: null },
          notices: [],
          approvals: [],
          eventCursor: 'seq:0',
          effectiveCapabilities: {
            capabilities: [
              'catalog.model',
              'catalog.effort',
              'catalog.permission',
            ].map((capabilityId) => ({
              capabilityId,
              supported: true,
              available: true,
              allowed: true,
            })),
          },
        }
      : null,
  )
  const scope = effectScope()
  const report = vi.fn()
  const options = {
    selected,
    snapshot,
    draft,
    models: ref(catalog),
    permissions: ref(catalog),
    permission: ref(''),
    report,
    refresh: vi.fn(async () => undefined),
  }
  const controls = scope.run(() => useRuntimeSelections(options))!
  return { scope, controls, ...options }
}

describe('工作台运行选择交互', () => {
  it('未到达的快照字段不清空选择，明确状态仍覆盖草稿', async () => {
    const value = state(true)
    value.snapshot.value!.state = {}
    await nextTick()
    expect(value.controls.modelId.value).toBe('model-logical')
    expect(value.permission.value).toBe('opaque-read')
    value.snapshot.value!.state = { selections: { model: 'opaque-deep' } }
    await nextTick()
    expect(value.controls.reasoningId.value).toBe('deep')
    expect(value.permission.value).toBe('opaque-read')
    value.scope.stop()
  })
  it('失效的旧模型不会假装选中了当前默认模型', async () => {
    const value = state()
    value.draft.value.modelId = 'stale-native-model'
    expect(value.controls.modelUnavailable.value).toBe(true)
    expect(value.controls.modelId.value).toBe('')
    expect(value.controls.modelLabel.value).toBe('模型已不可用，请重新选择')
    await value.controls.chooseModel('model-logical', 'light')
    expect(value.controls.modelUnavailable.value).toBe(false)
    value.scope.stop()
  })
  it('显示后端真实默认项，默认改变立即回显且不写入草稿或发选择请求', async () => {
    const rpc = vi.spyOn(conversationApi, 'selections').mockResolvedValue({})
    const value = state()
    value.models.value = {
      models: [
        {
          id: 'configured-model',
          displayName: '配置模型',
          enabled: true,
          default: true,
        },
      ],
    }
    value.permissions.value = {
      permissions: [
        {
          id: 'configured-permission',
          displayName: '配置权限',
          enabled: true,
          default: true,
        },
      ],
    }
    expect(value.controls.modelLabel.value).toBe('配置模型')
    expect(value.controls.modelId.value).toBe('configured-model')
    expect(value.controls.permissionLabel.value).toBe('配置权限')
    value.permissions.value.permissions![0]!.displayName = '更新权限'
    await nextTick()
    expect(value.controls.permissionLabel.value).toBe('更新权限')
    expect(value.draft.value.modelId).toBe('')
    expect(value.permission.value).toBe('')
    expect(rpc).not.toHaveBeenCalled()
    value.scope.stop()
  })
  it('新会话保留配置默认，显式选择推理使用opaque selectionId且不提前发RPC', async () => {
    const rpc = vi.spyOn(conversationApi, 'selections').mockResolvedValue({})
    const value = state()
    expect(value.draft.value.modelId).toBe('')
    await value.controls.chooseModel('model-logical', 'deep')
    expect(value.draft.value.modelId).toBe('opaque-deep')
    expect(value.controls.reasoningId.value).toBe('deep')
    await value.controls.chooseModel('model-logical', 'blocked')
    expect(value.draft.value.modelId).toBe('opaque-deep')
    expect(rpc).not.toHaveBeenCalled()
    value.scope.stop()
  })

  it('已有会话立即提交选择，拒绝时保留权威状态，不污染下一次发送', async () => {
    const rpc = vi
      .spyOn(conversationApi, 'selections')
      .mockRejectedValue(new Error('synthetic rejection'))
    const value = state(true)
    expect(value.controls.modelId.value).toBe('model-logical')
    await value.controls.chooseModel('model-logical', 'deep')
    expect(rpc).toHaveBeenCalledWith('synthetic-session', {
      model: 'opaque-deep',
    })
    expect(value.draft.value.modelId).toBe('opaque-light')
    expect(value.report).toHaveBeenCalledWith('synthetic rejection')
    value.snapshot.value!.session.takeover = false
    await nextTick()
    await value.controls.chooseModel('model-logical', 'deep')
    expect(rpc).toHaveBeenCalledTimes(1)
    value.scope.stop()
  })

  it('迟到的旧会话选择响应不会覆盖刚切换的会话', async () => {
    let resolve!: (value: object) => void
    vi.spyOn(conversationApi, 'selections').mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const value = state(true)
    const pending = value.controls.chooseModel('model-logical', 'deep')
    value.selected.value = 'other-session'
    value.snapshot.value = null
    value.draft.value = {
      text: '',
      files: [],
      deviceId: 'other',
      modelId: 'other-choice',
    }
    resolve({})
    await pending
    expect(value.draft.value.modelId).toBe('other-choice')
    value.scope.stop()
  })
})
