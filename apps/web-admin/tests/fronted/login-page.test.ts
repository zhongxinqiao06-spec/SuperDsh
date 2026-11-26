import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import LoginPage from '@/views/auth/LoginPage.vue'
import type { AuthConfig, AuthResponse } from '@/types/auth/auth'

const mocks = vi.hoisted(() => ({
  config: vi.fn<() => Promise<AuthConfig>>(),
  login: vi.fn<() => Promise<AuthResponse>>(),
  register: vi.fn<() => Promise<AuthResponse>>(),
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
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({ generation: 0, session: null }),
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: { generation: 0, accept: mocks.accept },
}))
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
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
  mocks.route.path = '/login'
  mocks.route.query = {}
  mocks.config.mockResolvedValue({ ...config })
  mocks.login.mockResolvedValue(identity)
  mocks.register.mockResolvedValue(identity)
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
    const inputs = page.findAll('input')
    expect(inputs).toHaveLength(4)
    await page
      .get('input[autocomplete="email"]')
      .setValue('fixture@example.invalid')
    for (const input of page.findAll('input[autocomplete="new-password"]')) {
      await input.setValue('Synthetic-register-password!')
    }
    await page.get('form').trigger('submit')
    expect(mocks.register).not.toHaveBeenCalled()
    await page.get('input[autocomplete="one-time-code"]').setValue('123456')
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
    expect(page.text()).toContain('暂时无法发送验证邮件')
    expect(
      page.get('button[type="submit"]').attributes('disabled'),
    ).toBeDefined()
    await page.get('form').trigger('submit')
    expect(mocks.register).not.toHaveBeenCalled()
  })
})
