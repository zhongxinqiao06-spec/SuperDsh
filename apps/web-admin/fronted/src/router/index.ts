import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from 'vue-router'
import { useAuthStore } from '@/store/modules/auth-store'
import { consoleModules } from '@/utils/console/modules'
import { productHome, productOf } from '@/utils/studio/products'
import { canonicalPath } from '@/utils/console/routes'
import { signedInDestination } from '@/utils/auth/native-oauth'
import { workspacePreviewContinuation } from '@/utils/file-preview/preview-location'

const pages: Record<string, RouteRecordRaw['component']> = {
  'office.history': () => import('@/views/workbench/HistoryPage.vue'),
  'office.devices': () => import('@/views/devices/MyDevicesPage.vue'),
  'product.members': () => import('@/views/products/ProductMembersPage.vue'),
  'product.defaults': () => import('@/views/products/ProductDefaultsPage.vue'),
  'platform.extensions': () => import('@/views/tools/ExtensionsPage.vue'),
  'studio.projects': () => import('@/views/studio/StudioHome.vue'),
  'studio.library': () => import('@/views/studio/StudioLibraryPage.vue'),
  'studio.characters': () => import('@/views/studio/StudioLibraryPage.vue'),
  'studio.environments': () => import('@/views/studio/StudioLibraryPage.vue'),
  'studio.props': () => import('@/views/studio/StudioLibraryPage.vue'),
  'studio.deliveries': () => import('@/views/studio/StudioTasksPage.vue'),
  'studio.tasks': () => import('@/views/studio/StudioTasksPage.vue'),
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

// Hash history 构建时会写入空首页，先收取物理入口中的 OAuth 回调和原生深链。
normalizeInitialLocation()
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
      path: '/products',
      component: () => import('@/views/products/ProductHome.vue'),
    },
    {
      path: '/console',
      component: () => import('@/layout/ConsoleLayout.vue'),
      meta: { console: true },
      children: [
        {
          path: '/office',
          component: () => import('@/views/products/OfficeHome.vue'),
          meta: { product: 'office', landing: true },
        },
        {
          path: '/entertainment/:project',
          component: () => import('@/views/studio/StudioEditor.vue'),
          meta: {
            product: 'entertainment',
            moduleId: 'studio.projects',
            projectEditor: true,
          },
        },
        ...consoleModules.map((module) => ({
          path: module.path,
          component: modulePage(module.id),
          meta: {
            moduleId: module.id,
            product: module.product,
          },
        })),
        {
          path: '/workspace/:pathMatch(.*)*',
          component: () => import('@/views/workbench/WorkbenchPage.vue'),
          meta: { moduleId: 'workbench', product: 'office' },
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

router.beforeEach(async (to, from) => {
  const auth = useAuthStore()
  const protectedPreview =
    to.path === '/preview' ? workspacePreviewContinuation(to.query) : null
  if (
    !to.meta.public ||
    protectedPreview ||
    ['/login', '/bootstrap', '/register'].includes(to.path)
  )
    await auth.hydrate()
  const canonical = canonicalPath(to.path, auth.session?.permissions)
  if (canonical && canonical !== to.path)
    return { path: canonical, query: to.query, replace: true }
  if ((!to.meta.public || protectedPreview) && !auth.authenticated)
    return {
      path: '/login',
      query: { returnTo: protectedPreview ?? to.fullPath },
    }
  const home = productHome(auth.session?.permissions)
  if (
    protectedPreview &&
    (!auth.can('products.office') || !auth.can('files.read'))
  )
    return home
  if (to.path === '/products' && home !== '/products') return home
  if (
    typeof to.meta.product === 'string' &&
    !auth.can('products.' + to.meta.product)
  )
    return home
  // 公共模块共用原路径，显式带上娱乐上下文，让刷新、复制链接和浏览器回退得到同一套菜单。
  if (to.meta.console && !to.meta.product) {
    const declared = productOf(to.query.product)
    if (declared && !auth.can('products.' + declared)) return home
    const inherited =
      productOf(from.meta.product) ?? productOf(from.query.product)
    if (
      !declared &&
      auth.can('products.entertainment') &&
      (inherited === 'entertainment' || !auth.can('products.office'))
    ) {
      return {
        path: to.path,
        query: { ...to.query, product: 'entertainment' },
        replace: true,
      }
    }
  }
  if (
    auth.authenticated &&
    ['/login', '/bootstrap', '/register'].includes(to.path)
  ) {
    return signedInDestination(to.query.returnTo, auth.session?.permissions)
  }
  return true
})

/** 静态托管下兼容原物理入口；URL参数随Hash迁入，不提交到其他来源。 */
export function normalizeInitialLocation(): void {
  if (!window.location.hash && window.location.pathname !== '/') {
    window.history.replaceState(
      window.history.state,
      '',
      `/#${window.location.pathname}${window.location.search}`,
    )
  }
}
