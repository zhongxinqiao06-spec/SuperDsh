import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import MarkdownContent from '@/components/MarkdownContent.vue'
import AccountPage from '@/views/account/AccountPage.vue'
import ScenarioShowcase from '@/views/website/components/ScenarioShowcase.vue'
import {
  allowedNativeRedirect,
  authContinuation,
} from '@/utils/auth/native-oauth'
import { markdownBlocks } from '@/utils/markdown'

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  identity: vi.fn(),
  generation: 0,
}))
vi.mock('@/api/account/account-api', () => ({
  accountApi: { profile: mocks.profile },
}))
vi.mock('@/api/auth/auth-api', () => ({
  authApi: { config: async () => ({ emailVerificationRequired: false }) },
}))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({
    generation: mocks.generation,
    session: {
      userId: 'synthetic-profile',
      displayName: '旧名称',
      username: 'fixture-user',
      email: 'fixture@example.invalid',
      roles: ['member'],
    },
  }),
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: {
    get generation() {
      return mocks.generation
    },
    updateIdentity: mocks.identity,
  },
}))

let wrapper: VueWrapper | undefined
beforeEach(() => {
  mocks.generation = 0
  mocks.profile.mockReset()
  mocks.identity.mockReset()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('第二阶段公共交互与身份隔离', () => {
  it('Markdown 将恶意HTML与脚本链接渲染为文本，同时保留安全格式', () => {
    wrapper = mount(MarkdownContent, {
      props: {
        content:
          '# 标题\n**强调** [来源](https://example.invalid/source)\n<script>alert(1)</script> [恶意](javascript:alert(1))\n```\nconst a = 1\n```',
      },
    })
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.findAll('a')).toHaveLength(1)
    expect(wrapper.get('a').attributes('rel')).toContain('noopener')
    expect(wrapper.get('strong').text()).toBe('强调')
    expect(markdownBlocks('```\n未闭合代码')[0]?.kind).toBe('code')
  })

  it('资料保存失败保留草稿，成功仅更新本人身份', async () => {
    mocks.profile
      .mockRejectedValueOnce(new Error('合成服务失败'))
      .mockResolvedValueOnce({
        userId: 'synthetic-profile',
        displayName: '保留草稿',
      })
    wrapper = mount(AccountPage, {
      global: { plugins: [createPinia(), ElementPlus] },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '修改昵称')!
      .trigger('click')
    await flushPromises()
    const dialog = wrapper.get('[role="dialog"][aria-label="修改昵称"]')
    await dialog.get('input').setValue('保留草稿')
    await dialog.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.profile).toHaveBeenCalledWith('保留草稿')
    expect(dialog.text()).toContain('合成服务失败')
    expect(dialog.get('input').element).toHaveProperty('value', '保留草稿')
    expect(mocks.identity).not.toHaveBeenCalled()
    await dialog.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.identity).toHaveBeenCalledWith({
      userId: 'synthetic-profile',
      displayName: '保留草稿',
    })
  })

  it('账号切换后拒绝迟到的资料保存回写', async () => {
    let complete: (value: unknown) => void = () => undefined
    mocks.profile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    wrapper = mount(AccountPage, {
      global: { plugins: [createPinia(), ElementPlus] },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '修改昵称')!
      .trigger('click')
    await flushPromises()
    const dialog = wrapper.get('[role="dialog"][aria-label="修改昵称"]')
    await dialog.get('input').setValue('旧账号待保存草稿')
    await dialog.get('form').trigger('submit')
    expect(mocks.profile).toHaveBeenCalledWith('旧账号待保存草稿')
    mocks.generation++
    complete({ userId: 'synthetic-profile', displayName: '过期结果' })
    await flushPromises()
    expect(mocks.identity).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('已保存 / Saved')
  })

  it('官网场景保留键盘切换、示例数据与幻灯交互', async () => {
    wrapper = mount(ScenarioShowcase, {
      global: { plugins: [createPinia()], stubs: { RouterLink: true } },
    })
    expect(wrapper.get('a[download]').attributes('href')).toContain(
      'sales-example.csv',
    )
    await wrapper
      .findAll('[role="tab"]')[0]!
      .trigger('keydown', { key: 'ArrowRight' })
    expect(
      wrapper.findAll('[role="tab"]')[1]!.attributes('aria-selected'),
    ).toBe('true')
    await wrapper.get('button[aria-label="下一页"]').trigger('click')
    expect(wrapper.text()).toContain('把数据看清')
    await wrapper.findAll('[role="tab"]')[1]!.trigger('keydown', { key: 'End' })
    expect(wrapper.text()).toContain('查看资料来源')
  })

  it('授权与取消只允许产品回调和本地续接入口', () => {
    expect(
      allowedNativeRedirect(
        'superdsh-desktop',
        'http://127.0.0.1:51759/oauth/callback',
      ),
    ).toBe(true)
    expect(
      allowedNativeRedirect(
        'superdsh-desktop',
        'https://attacker.invalid/oauth/callback',
      ),
    ).toBe(false)
    expect(
      allowedNativeRedirect(
        'agents-anywhere-mobile',
        'agents-anywhere://oauth/callback',
      ),
    ).toBe(true)
    expect(authContinuation('/mobile-oauth?state=synthetic')).toContain(
      'synthetic',
    )
    expect(authContinuation('//attacker.invalid')).toBeNull()
  })
})
