import { request } from '@/utils/request'
import type { AuthConfig, AuthResponse, Identity } from '@/types/auth/auth'
import {
  createPasswordVerifier,
  derivePasswordVerifier,
} from '@/utils/auth/password-verifier'
import { sessionController } from '@/store/session-controller'

/** 认证资源接口；所有路径相对统一API入口。 */
export const authApi = {
  authorize: (body: Record<string, string>) =>
    request<{ redirectUrl: string }>('/oauth/authorize', {
      method: 'POST',
      body,
    }),
  config: (signal?: AbortSignal) =>
    request<AuthConfig>('/auth/config', { auth: false, signal }),
  me: (signal?: AbortSignal) => request<Identity>('/auth/me', { signal }),
  async login(
    identifier: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<AuthResponse> {
    await sessionController.beforeLogin()
    const normalized = identifier.trim().toLowerCase()
    const { salt } = await request<{ salt: string }>('/auth/password-salt', {
      method: 'POST',
      body: { identifier: normalized },
      auth: false,
      signal,
    })
    return request<AuthResponse>('/auth/login', {
      method: 'POST',
      auth: false,
      signal,
      body: {
        identifier: normalized,
        passwordVerifier: await derivePasswordVerifier(password, salt),
      },
    })
  },
  async register(
    input: {
      username: string
      displayName: string
      password: string
      email?: string
      code?: string
    },
    signal?: AbortSignal,
  ): Promise<AuthResponse> {
    await sessionController.beforeLogin()
    const { password, ...profile } = input
    return request<AuthResponse>('/auth/register', {
      method: 'POST',
      auth: false,
      signal,
      body: { ...profile, ...(await createPasswordVerifier(password)) },
    })
  },
  changePassword: async (password: string) => {
    const value = await createPasswordVerifier(password)
    return request<void>('/auth/change-password', {
      method: 'POST',
      body: {
        newPasswordVerifier: value.passwordVerifier,
        newPasswordSalt: value.passwordSalt,
      },
    })
  },
  async recover(
    input: {
      identifier: string
      email: string
      code: string
      recoveryCode: string
      password: string
    },
    useEmail: boolean,
  ) {
    const value = await createPasswordVerifier(input.password)
    return request<void>(
      useEmail ? '/auth/recovery/reset-email' : '/auth/recovery/reset',
      {
        method: 'POST',
        auth: false,
        body: {
          identifier: input.identifier,
          email: input.email,
          code: input.code,
          recoveryCode: input.recoveryCode,
          newPasswordVerifier: value.passwordVerifier,
          newPasswordSalt: value.passwordSalt,
        },
      },
    )
  },
  oauthStart: (returnTo: string) =>
    request<{ authorizeUrl: string }>(
      `/auth/oauth/start?${new URLSearchParams({ returnTo })}`,
      { auth: false },
    ),
  oauthFinalize: (body: Record<string, unknown>) =>
    request<AuthResponse>('/auth/oauth/finalize', {
      method: 'POST',
      auth: false,
      body,
    }),
}
