import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useStorage } from '@/composables/storage/use-storage'
import { useDeviceInventory } from '@/composables/devices/use-device-inventory'
import {
  connectionDraft,
  connectionInput,
} from '@/utils/storage/storage-drafts'
import {
  configurationErrors,
  runtimeDraft,
} from '@/utils/devices/runtime-config'
import { previewKind } from '@/utils/files/presentation'
import type { StorageConnection } from '@/types/storage/storage'
import type { Device } from '@/types/devices/devices'

const mocks = vi.hoisted(() => ({
  generation: 0,
  save: vi.fn(),
  inventory: vi.fn(),
  block: vi.fn(),
  resume: vi.fn(),
  allowed: true,
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: {
    get generation() {
      return mocks.generation
    },
  },
}))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({
    get generation() {
      return mocks.generation
    },
    can: () => mocks.allowed,
  }),
}))
vi.mock('@/api/storage/storage-api', () => ({
  storageApi: {
    settings: async () => ({
      activeConnectionId: 'local',
      revision: 2,
      policy: { maxFileBytes: 100, temporaryHours: 24, recycleDays: 30 },
      connections: [],
    }),
    usage: async () => ({ files: 0, bytes: 0, items: [] }),
    migrations: async () => ({ items: [], records: [] }),
    saveConnection: mocks.save,
  },
}))
vi.mock('@/api/devices/devices-api', () => ({
  devicesApi: {
    inventory: mocks.inventory,
    block: mocks.block,
    resume: mocks.resume,
  },
}))
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  mocks.generation = 0
  mocks.allowed = true
  mocks.inventory.mockResolvedValue({
    devices: [],
    total: 0,
    page: 1,
    pageSize: 10,
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})
const connection: StorageConnection = {
  id: 'synthetic',
  name: '合成存储',
  backend: 's3',
  configuration: {
    backend: 's3',
    endpoint: 'https://synthetic.invalid',
    bucket: 'synthetic',
    region: 'synthetic',
  },
  enabled: true,
  credentialConfigured: true,
  revision: 7,
}
const device: Device = {
  id: 'device',
  userId: 'synthetic-owner',
  name: '合成设备',
  connectorKind: 'desktop',
  executorKind: 'desktop',
  deviceOs: 'synthetic-os',
  status: 'online',
  lastSeenAt: null,
  blockedAt: null,
  blockedReason: null,
  version: null,
}

describe('文件、存储、设备交互边界', () => {
  it('存储密钥空白保留，半份凭据拒绝且编辑不改原配置', () => {
    const draft = connectionDraft(connection)
    expect(connectionInput(draft, 7).credentials).toBeUndefined()
    draft.endpoint = 'https://changed.invalid'
    expect(connection.configuration.endpoint).toBe('https://synthetic.invalid')
    draft.accessKeyId = 'partial'
    expect(() => connectionInput(draft)).toThrow('一起填写')
  })
  it('保存冲突保留连接草稿，不自动重发或丢掉修订', async () => {
    let vm!: ReturnType<typeof useStorage>
    wrapper = mount(
      defineComponent({
        setup() {
          vm = useStorage()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    vm.edit(connection)
    vm.draft.name = '待确认草稿'
    mocks.save.mockRejectedValueOnce(new Error('修订已更新'))
    await vm.save()
    expect(vm.editing.value).toEqual(connection)
    expect(vm.draft.name).toBe('待确认草稿')
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(mocks.save.mock.calls[0]![0].revision).toBe(7)
    expect(vm.mutation.error.value).toBe('修订已更新')
  })
  it('运维阻断要求写权限，失败后保留设备与原因', async () => {
    let vm!: ReturnType<typeof useDeviceInventory>
    wrapper = mount(
      defineComponent({
        setup() {
          vm = useDeviceInventory()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    vm.select(device)
    vm.reason.value = '合成排查'
    mocks.allowed = false
    await vm.operate()
    expect(mocks.block).not.toHaveBeenCalled()
    mocks.allowed = true
    mocks.block.mockRejectedValueOnce(new Error('设备连接状态已变化'))
    await vm.operate()
    expect(vm.selected.value?.id).toBe(device.id)
    expect(vm.reason.value).toBe('合成排查')
    expect(mocks.block).toHaveBeenCalledWith(device.id, '合成排查')
  })
  it('运行配置深拷贝并在Schema边界拒绝空必填、非法枚举与损坏数组', () => {
    const defaults = { nested: { path: '/synthetic' } }
    const draft = runtimeDraft({
      runtimeType: 'synthetic',
      displayName: '合成',
      defaults,
    })
    ;(draft.config.nested as { path: string }).path = '/changed'
    expect(defaults.nested.path).toBe('/synthetic')
    expect(
      configurationErrors(
        {
          required: ['name'],
          properties: {
            name: { title: '实例名称' },
            mode: { enum: ['safe'] },
            args: { type: 'array' },
          },
        },
        { mode: 'unknown', args: 'broken' },
      ),
    ).toEqual(['实例名称不能为空', 'mode不是允许的选项', 'args必须是有效数组'])
  })
  it('主动文档不可作为图片或HTML预览执行', () => {
    expect(previewKind('text/html')).toBeNull()
    expect(previewKind('image/svg+xml')).toBeNull()
    expect(previewKind('image/png')).toBe('image')
    expect(previewKind('text/markdown')).toBe('text')
  })
})
