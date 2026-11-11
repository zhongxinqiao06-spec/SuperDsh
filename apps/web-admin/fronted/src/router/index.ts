import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from 'vue-router'
import { useAuthStore } from '@/store/modules/auth-store'
import { consoleModules } from '@/utils/console/modules'
import { canonicalPath } from '@/utils/console/routes'
import { authContinuation } from '@/utils/auth/native-oauth'

const pages: Record<string, RouteRecordRaw['component']> = {
  overview: () => import('@/views/console/OverviewPage.vue'),
  'access.users': () => import('@/views/access/UsersPage.vue'),
  'access.roles': () => import('@/views/access/RolesPage.vue'),
  'access.menus': () => import('@/views/console/MenusPage.vue'),
  'account.profile': () => import('@/views/account/AccountPage.vue'),
  'account.security': () => import('@/views/account/SecurityPage.vue'),
  'account.appearance': () => import('@/views/account/AppearancePage.vue'),
  workbench: () => import('@/views/workbench/WorkbenchPage.vue'),
  models: () => import('@/views/models/ModelsPage.vue'),
  'models.multimodal': () => import('@/views/models/ModelsPage.vue'),
  'account.models': () => import('@/views/models/ModelsPage.vue'),
  agents: () => import('@/views/agents/AgentsPage.vue'),
  knowledge: () => import('@/views/knowledge/KnowledgePage.vue'),
  'account.files': () => import('@/views/files/FilesPage.vue'),
  'system.storage': () => import('@/views/storage/StoragePage.vue'),
  devices: () => import('@/views/devices/DevicesPage.vue'),
  skills: () => import('@/views/skills/SkillsPage.vue'),
  tools: () => import('@/views/tools/ToolsPage.vue'),
  'system.service': () => import('@/views/service/ServicePage.vue'),
  'system.audit': () => import('@/views/audit/AuditPage.vue'),
  'account.mobile': () =>
    import('@/views/mobile-connections/MobileConnectionsPage.vue'),
}

/** 产品模块必须显式装配页面，遗漏在启动时失败，不能显示未迁移占位页。 */
function modulePage(
  identifier: string,
): NonNullable<RouteRecordRaw['component']> {
  const page = pages[identifier]
  if (!page) throw new Error(`管理模块未装配页面：${identifier}`)
  return page
}

/** 页面路由保留产品模块与旧Hash入口，模块不导入服务端实现。 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      alias: '/website',
      component: () => import('@/views/website/WebsitePage.vue'),
      meta: { public: true },
    },
    {
      path: '/login',
      alias: ['/bootstrap', '/register'],
      component: () => import('@/views/auth/LoginPage.vue'),
      meta: { public: true },
    },
    {
      path: '/privacy',
      component: () => import('@/views/website/PrivacyPage.vue'),
      meta: { public: true },
    },
    {
      path: '/share/:shareId',
      component: () => import('@/views/share/SharePage.vue'),
      meta: { public: true },
    },
    {
      path: '/preview',
      component: () => import('@/views/file-preview/FilePreviewPage.vue'),
      meta: { public: true },
    },
    ...[
      '/mobile-oauth',
      '/desktop-oauth',
      '/plugin-oauth',
      '/oauth/authorize',
    ].map((path) => ({
      path,
      component: () => import('@/views/auth/NativeOAuthPage.vue'),
      meta: { public: true },
    })),
    {
      path: '/console',
      component: () => import('@/layout/ConsoleLayout.vue'),
      children: [
        ...consoleModules.map((module) => ({
          path: module.path,
          component: modulePage(module.id),
          meta: { moduleId: module.id },
        })),
        {
          path: '/workspace/:pathMatch(.*)*',
          component: () => import('@/views/workbench/WorkbenchPage.vue'),
          meta: { moduleId: 'workbench' },
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      component: () => import('@/views/common/NotFoundPage.vue'),
      meta: { public: true },
    },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (
    !to.meta.public ||
    ['/login', '/bootstrap', '/register'].includes(to.path)
  )
    await auth.hydrate()
  const canonical = canonicalPath(to.path, auth.session?.permissions)
  if (canonical && canonical !== to.path)
    return { path: canonical, query: to.query, replace: true }
  if (!to.meta.public && !auth.authenticated)
    return { path: '/login', query: { returnTo: to.path } }
  if (
    auth.authenticated &&
    ['/login', '/bootstrap', '/register'].includes(to.path)
  ) {
    return typeof to.query.returnTo === 'string'
      ? (authContinuation(to.query.returnTo) ??
          canonicalPath(to.query.returnTo, auth.session?.permissions) ??
          '/overview')
      : '/overview'
  }
  return true
})

/** 静态托管下兼容原物理入口；URL参数随Hash迁入，不提交到其他来源。 */
export function normalizeInitialLocation(): void {
  if (!window.location.hash && window.location.pathname !== '/') {
    window.location.hash = `${window.location.pathname}${window.location.search}`
  }
}
