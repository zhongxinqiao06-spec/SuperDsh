import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import LoginPage from '@/views/auth/LoginPage.vue'
import { router } from '@/router'
import type { AuthConfig, AuthResponse } from '@/types/auth/auth'

const mocks = vi.hoisted(() => ({
  config: vi.fn<() => Promise<AuthConfig>>(),
  login: vi.fn<() => Promise<AuthResponse>>(),
  register: vi.fn<() => Promise<AuthResponse>>(),
  emailCode: vi.fn(),
  accept: vi.fn(),
  replace: vi.fn(),
  route: { path: '/login', query: {} },
}))

vi.mock('@/api/auth/auth-api', () => ({
  authApi: {
    config: mocks.config,
    login: mocks.login,
    register: mocks.register,
  },
}))
vi.mock('@/api/account/account-api', () => ({
  accountApi: { emailCode: mocks.emailCode },
}))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({ generation: 0, session: null }),
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: { generation: 0, accept: mocks.accept },
}))
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRoute: () => mocks.route,
  useRouter: () => ({ resolve: router.resolve, replace: mocks.replace }),
}))

const identity: AuthResponse = {
  userId: 'login-fixture-admin',
  username: 'fixture-admin',
  displayName: '合成管理员',
  email: null,
  role: 'admin',
  roles: ['admin'],
  permissions: [],
  authzVersion: 1,
  accessToken: 'fixture-token',
  tokenType: 'bearer',
}
const config: AuthConfig = {
  needsBootstrap: false,
  registrationOpen: false,
  oauthEnabled: false,
  emailVerificationRequired: false,
}
let wrapper: VueWrapper | undefined

/** 组件回归使用合成认证接口，不启动服务、不访问实际账号与数据库。 */
async function renderLogin() {
  wrapper = mount(LoginPage, {
    global: {
      plugins: [createPinia(), ElementPlus],
      stubs: { RouterLink: true },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  sessionStorage.clear()
  mocks.route.path = '/login'
  mocks.route.query = {}
  mocks.config.mockResolvedValue({ ...config })
  mocks.login.mockResolvedValue(identity)
  mocks.register.mockResolvedValue(identity)
  mocks.emailCode.mockResolvedValue({ serverTime: new Date().toISOString() })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('管理员配置初始化后的认证入口', () => {
  it('直接显示空白登录表单并完成正常登录', async () => {
    const page = await renderLogin()
    expect(page.get('h1').text()).toContain('登录')
    expect(page.text()).not.toContain('初始化令牌')
    expect(page.text()).not.toContain('创建管理员')
    const inputs = page.findAll('input')
    expect(inputs).toHaveLength(2)
    expect(inputs.every((input) => input.element.value === '')).toBe(true)
    await page.get('input[autocomplete="username"]').setValue('fixture-admin')
    await page
      .get('input[autocomplete="current-password"]')
      .setValue('Synthetic-login-password!')
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.login).toHaveBeenCalledWith(
      'fixture-admin',
      'Synthetic-login-password!',
      expect.any(AbortSignal),
    )
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.accept).toHaveBeenCalledWith(identity)
    expect(mocks.replace).toHaveBeenCalledWith('/account/profile')
  })

  it.each(['/login', '/register', '/bootstrap'])(
    '服务端初始化未完成时 %s 只提示配置并阻止认证请求',
    async (path) => {
      mocks.route.path = path
      mocks.config.mockResolvedValue({
        ...config,
        needsBootstrap: true,
        registrationOpen: true,
      })
      const page = await renderLogin()
      expect(page.text()).toContain('管理员由服务端按配置自动创建')
      expect(page.text()).not.toContain('初始化令牌')
      expect(page.text()).not.toContain('创建管理员')
      expect(page.findAll('input')).toHaveLength(2)
      expect(
        page.get('button[type="submit"]').attributes('disabled'),
      ).toBeDefined()
      await page.get('input[autocomplete="username"]').setValue('fixture-admin')
      await page
        .get('input[autocomplete="current-password"]')
        .setValue('Synthetic-login-password!')
      // 直接派发表单事件，验证提交逻辑本身也封锁，而非仅依赖禁用按钮。
      await page.get('form').trigger('submit')
      await flushPromises()
      expect(mocks.login).not.toHaveBeenCalled()
      expect(mocks.register).not.toHaveBeenCalled()
      expect(mocks.accept).not.toHaveBeenCalled()
    },
  )

  it('注册关闭时旧注册路径显示登录表单', async () => {
    mocks.route.path = '/register'
    const page = await renderLogin()
    expect(page.get('h1').text()).toContain('登录')
    expect(page.findAll('input')).toHaveLength(2)
    expect(page.text()).not.toContain('确认密码')
  })

  it.each([
    ['/office', 'office'],
    ['/entertainment/works', 'entertainment'],
  ])('从 %s 提交邮箱验证并选择默认角色的产品', async (returnTo, product) => {
    mocks.route.path = '/register'
    mocks.route.query = { returnTo }
    mocks.config.mockResolvedValue({
      ...config,
      registrationOpen: true,
      registrationEmailAvailable: true,
    })
    const page = await renderLogin()
    expect(page.get('.login-intro--registration').text()).toContain(
      product === 'entertainment' ? '星桥娱乐' : '星桥办公',
    )
    await page
      .get('input[autocomplete="email"]')
      .setValue('fixture@example.invalid')
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.emailCode).toHaveBeenCalledWith(
      'fixture@example.invalid',
      'register',
      '',
      expect.any(AbortSignal),
    )
    expect(mocks.register).not.toHaveBeenCalled()
    await page.get('input[autocomplete="one-time-code"]').setValue('123456')
    await page
      .get('input[autocomplete="new-password"]')
      .setValue('Synthetic-register-password!')
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.register).toHaveBeenCalledWith(
      {
        email: 'fixture@example.invalid',
        product,
        password: 'Synthetic-register-password!',
        code: '123456',
      },
      expect.any(AbortSignal),
    )
    expect(mocks.login).not.toHaveBeenCalled()
  })
  it('邮件不可用时保留注册表单并阻止提交', async () => {
    mocks.route.path = '/register'
    mocks.config.mockResolvedValue({
      ...config,
      registrationOpen: true,
      registrationEmailAvailable: false,
    })
    const page = await renderLogin()
    expect(page.get('[role="status"]').text()).toContain(
      '注册邮件服务暂时不可用',
    )
    expect(page.find('button[type="submit"]').exists()).toBe(false)
    await page.get('form').trigger('submit')
    expect(mocks.emailCode).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
  })
})
