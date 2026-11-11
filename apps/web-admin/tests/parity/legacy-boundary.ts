import type { IncomingMessage, ServerResponse } from 'node:http'

/** 隔离旧 Node 工程的运行时加载，不把旧包第三方声明文件混进 Vue 的编译配置。 */
export async function loadLegacy<T>(relative: string): Promise<T> {
  const source = new URL(`../../../admin/server/${relative}`, import.meta.url)
  return (await import(source.href)) as T
}

export interface LegacyAccount {
  userId: string
  username: string
  email: string | null
  emailVerified: boolean
  displayName: string
  role: string
  roles: string[]
  permissions: string[]
  authzVersion: number
  resetRequired: boolean
  disabled: boolean
  deletedAt: string | null
}

export interface LegacyRouter {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: { signal: AbortSignal },
  ): Promise<void>
}

export interface LegacyApi {
  ApiError: new (status: number, detail: string) => Error & { status: number }
  ApiRouter: new (
    authorize: (
      request: IncomingMessage,
      permission?: string,
    ) => Promise<LegacyAccount>,
  ) => LegacyRouter
}

export interface LegacyMenu extends Record<string, unknown> {
  id: string
  title: string
}

export interface LegacyNavigation {
  icons: string[]
  modules: { id: string; permissions: string[] }[]
  defaultMenuItems(): LegacyMenu[]
  assertMenuEditAllowed(
    previous: LegacyMenu[],
    next: LegacyMenu[],
    permissions: string[],
  ): void
  validateMenuItems(value: unknown, roles: string[]): LegacyMenu[]
  visibleMenuItems(items: LegacyMenu[], user: LegacyAccount): LegacyMenu[]
}

export interface LegacyIdentityRoutes {
  registerIdentityRoutes(router: LegacyRouter, identity: unknown): void
}
