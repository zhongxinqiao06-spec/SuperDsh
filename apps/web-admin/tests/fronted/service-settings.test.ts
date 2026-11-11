import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import ServicePage from '@/views/service/ServicePage.vue'
import type { ServiceSettings } from '@/types/service/system'

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  update: vi.fn(),
}))
vi.mock('@/api/service/system-api', () => ({
  systemApi: {
    settings: mocks.settings,
    updateSettings: mocks.update,
    announcement: async () => ({
      enabled: false,
      markdown: '',
      revision: 1,
      publishedAt: null,
    }),
    information: async () => ({
      endpoint: 'https://synthetic.invalid',
      version: 'fixture',
      database: 'postgresql',
      databasePath: '',
      startedAt: '2026-11-10T00:00:00Z',
      uptimeSeconds: 60,
    }),
  },
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: { generation: 1 },
}))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({ generation: 1 }),
}))
let wrapper: VueWrapper | undefined
let saved: ServiceSettings

async function renderService() {
  wrapper = mount(ServicePage, {
    global: { plugins: [createPinia(), ElementPlus] },
  })
  await flushPromises()
  return wrapper
}

async function openSection(page: VueWrapper, title: string) {
  const card = page
    .findAll('.settings-card')
    .find((item) => item.find('h2').text() === title)
  if (!card) throw new Error(`缺少分区：${title}`)
  await card.get('button').trigger('click')
  await flushPromises()
  return page.get(`[role="dialog"][aria-label="${title}"]`)
}

beforeEach(() => {
  saved = {
    registrationOpen: false,
    oauthRegistrationOpen: false,
    revision: 7,
    oauth: null,
    email: { enabled: false, fromAddress: '', apiKeyConfigured: false },
  }
  mocks.settings
    .mockReset()
    .mockImplementation(async () => structuredClone(saved))
  mocks.update
    .mockReset()
    .mockImplementation(async (update: Partial<ServiceSettings>) => {
      saved = {
        ...saved,
        ...structuredClone(update),
        revision: saved.revision + 1,
      }
      return structuredClone(saved)
    })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('未配置 OAuth 的真实服务配置合同', () => {
  it('null 提供方可渲染与打开禁用草稿，取消再打开不遗留修改', async () => {
    const page = await renderService()
    const card = page
      .findAll('.settings-card')
      .find((item) => item.find('h2').text() === 'OAuth')
    expect(card?.text()).toContain('未启用')
    let dialog = await openSection(page, 'OAuth')
    expect(dialog.get('.field input').element).toHaveProperty('value', 'oidc')
    await dialog.get('.field input').setValue('unsaved-provider')
    await dialog
      .findAll('button')
      .find((button) => button.text() === '取消')!
      .trigger('click')
    await flushPromises()
    dialog = await openSection(page, 'OAuth')
    expect(dialog.get('.field input').element).toHaveProperty('value', 'oidc')
    expect(saved.oauth).toBeNull()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('访问和邮件仅保存本分区，不配置 OAuth，也不提交密钥读取标志', async () => {
    const page = await renderService()
    const access = await openSection(page, '访问')
    await access.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.update).toHaveBeenNthCalledWith(1, {
      revision: 7,
      registrationOpen: false,
      oauthRegistrationOpen: false,
    })
    const email = await openSection(page, '邮箱验证 · Resend')
    await email
      .get('.field input')
      .setValue('Synthetic <sender@example.invalid>')
    await email.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.update).toHaveBeenNthCalledWith(2, {
      revision: 8,
      email: {
        enabled: false,
        fromAddress: 'Synthetic <sender@example.invalid>',
      },
    })
    expect(saved.oauth).toBeNull()
  })

  it('已有密钥的 OAuth 编辑留空保留，失败保稿，不携带邮件或访问配置', async () => {
    saved.oauth = {
      enabled: true,
      provider: 'configured',
      clientSecretConfigured: true,
    }
    mocks.update.mockRejectedValueOnce(new Error('合成版本冲突'))
    const page = await renderService()
    const dialog = await openSection(page, 'OAuth')
    await dialog.get('.field input').setValue('edited-provider')
    await dialog.get('form').trigger('submit')
    await flushPromises()
    const payload: Partial<ServiceSettings> = mocks.update.mock.calls[0]![0]
    expect(Object.keys(payload).sort()).toEqual(['oauth', 'revision'])
    expect(payload.oauth).toMatchObject({
      enabled: true,
      provider: 'edited-provider',
      clearClientSecret: false,
    })
    expect(payload.oauth).not.toHaveProperty('clientSecret')
    expect(payload.oauth).not.toHaveProperty('clientSecretConfigured')
    expect(dialog.text()).toContain('合成版本冲突')
    expect(dialog.get('.field input').element).toHaveProperty(
      'value',
      'edited-provider',
    )
    expect(saved.oauth.provider).toBe('configured')
  })
})
