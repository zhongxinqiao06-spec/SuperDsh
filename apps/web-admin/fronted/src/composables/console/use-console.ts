import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/store/modules/auth-store'
import { sessionController } from '@/store/session-controller'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { usePreferences } from '@/store/modules/preferences'
import { navigationApi } from '@/api/console/navigation-api'
import {
  canOpenModule,
  consoleModules,
  visibleNavigation,
} from '@/utils/console/modules'
import type {
  MenuNode,
  NavigationDisplayItem,
} from '@/types/console/navigation'
import {
  consoleTabGroups,
  homeFirst,
  navigationGroups,
} from '@/utils/console/navigation-display'
import { productHome, productOf } from '@/utils/studio/products'

/** 后台壳只读取身份与菜单，定时刷新撤权状态，不触发工作台运行服务。 */
export function useConsole() {
  const auth = useAuthStore(),
    route = useRoute(),
    router = useRouter(),
    preferences = usePreferences()
  let signingOut = false
  const product = computed(
    () =>
      productOf(route.meta.product) ??
      productOf(route.query.product) ??
      (auth.can('products.office') ? 'office' : undefined),
  )
  const home = computed(() =>
    product.value === 'entertainment'
      ? '/entertainment'
      : product.value === 'office'
        ? '/office'
        : productHome(auth.session?.permissions),
  )
  const productName = computed(() =>
    product.value === 'entertainment'
      ? preferences.tr('星桥娱乐', 'Starbridge Studio')
      : product.value === 'office'
        ? preferences.tr('星桥办公', 'Starbridge Office')
        : preferences.tr('星桥', 'Starbridge'),
  )
  const canSwitch = computed(
    () => auth.can('products.office') && auth.can('products.entertainment'),
  )
  const navigation = useResource((signal) =>
      navigationApi.get(product.value, signal),
    ),
    mutation = useMutation()
  const sidebar = ref(true),
    mobileOpen = ref(false),
    expanded = ref<string | null>(null),
    signOutOpen = ref(false)
  const module = computed(() =>
    consoleModules.find((item) => item.id === route.meta.moduleId),
  )
  const permitted = computed(() =>
    Boolean(
      auth.authenticated &&
      (!product.value || auth.can('products.' + product.value)) &&
      (!route.meta.studioCreation || auth.can('studio.projects.write')) &&
      (route.meta.landing ||
        (module.value &&
          canOpenModule(
            module.value,
            auth.session?.permissions ?? [],
            product.value,
          ))),
    ),
  )
  const items = computed(() =>
    homeFirst(
      visibleNavigation(
        navigation.data.value?.items ?? [],
        auth.session?.permissions ?? [],
        auth.session?.roles ?? [],
        product.value,
      ),
    ),
  )
  const tabGroup = computed(() =>
    consoleTabGroups.find((group) =>
      group.some(([id]) => id === module.value?.id),
    ),
  )
  const activeItem = computed(
    () =>
      items.value.find((item) => item.moduleId === module.value?.id) ??
      items.value.find((item) => item.moduleId === tabGroup.value?.[0]?.[0]),
  )
  const tabs = computed(() =>
    (tabGroup.value ?? []).flatMap(([id, zh, en]) => {
      const entry = consoleModules.find((m) => m.id === id)
      return entry &&
        canOpenModule(entry, auth.session?.permissions ?? [], product.value)
        ? [{ id, title: preferences.tr(zh, en), path: contextPath(entry.path) }]
        : []
    }),
  )
  const parent = computed(() =>
    items.value.find((item) => item.id === activeItem.value?.parentId),
  )
  const title = computed(() =>
    route.meta.landing
      ? preferences.tr('办公首页', 'Office home')
      : activeItem.value
        ? label(activeItem.value)
        : module.value
          ? preferences.tr(module.value.title, module.value.englishTitle)
          : preferences.tr('页面不存在', 'Page not found'),
  )
  const entries = computed<NavigationDisplayItem[]>(() =>
    items.value
      .filter(
        (item) =>
          item.moduleId !== 'account.mobile' || preferences.mobileSidebar,
      )
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        parentId: item.parentId,
        title: label(item),
        icon: item.icon,
        path: path(item),
        active: item.kind === 'page' && item.id === activeItem.value?.id,
      })),
  )
  const abort = new AbortController()
  let timer: ReturnType<typeof setInterval> | null = null
  const reloadNavigation = () => {
    void navigation.reload()
  }
  watch(product, () => {
    navigation.data.value = null
    expanded.value = null
    reloadNavigation()
  })
  function label(item: MenuNode): string {
    const target = consoleModules.find((entry) => entry.id === item.moduleId)
    if (target && target.title === item.title)
      return preferences.tr(target.title, target.englishTitle)
    const group = navigationGroups[item.id]
    if (group && item.title === group[0])
      return preferences.tr(group[0], group[1])
    return item.title
  }
  function path(item: MenuNode): string {
    const target = consoleModules.find((entry) => entry.id === item.moduleId)
    return target ? contextPath(target.path, !!target.product) : home.value
  }
  function contextPath(path: string, dedicated = false): string {
    return product.value === 'entertainment' && !dedicated
      ? path + '?product=entertainment'
      : path
  }
  // 菜单修订刷新只更新条目。用户刚展开的分组不能被同一路由的迟到刷新收起。
  watch(
    [
      () => module.value?.id,
      () => activeItem.value?.parentId,
      () => {
        const workspace = route.meta.landing
          ? 'workbench'
          : module.value?.id === 'studio.create'
            ? 'studio.projects'
            : null
        return workspace
          ? items.value.find((item) => item.moduleId === workspace)?.parentId
          : null
      },
    ],
    ([, parentId, landingGroup]) => {
      expanded.value = parentId ?? landingGroup ?? null
    },
  )
  watch(
    () => route.fullPath,
    () => {
      mobileOpen.value = false
    },
  )
  watch(
    () => auth.authenticated,
    (value) => {
      // 身份过期时保留当前作品、文件或会话。主动退出则由退出流程返回独立登录页。
      if (
        !value &&
        !sessionController.explicitlySignedOut &&
        route.meta.console
      )
        void router.replace({
          path: '/login',
          query: { returnTo: route.fullPath },
        })
    },
  )
  watch(
    () => auth.session?.authzVersion,
    () => {
      if (!auth.authenticated) return
      if (product.value && !auth.can('products.' + product.value))
        void router.replace(productHome(auth.session?.permissions))
      else reloadNavigation()
    },
  )
  onMounted(() => {
    window.addEventListener('starbridge:navigation-changed', reloadNavigation)
    timer = setInterval(() => {
      void auth
        .refreshIdentity(abort.signal)
        .then(reloadNavigation)
        .catch(() => undefined)
    }, 30_000)
  })
  onScopeDispose(() => {
    abort.abort()
    if (timer) clearInterval(timer)
    window.removeEventListener(
      'starbridge:navigation-changed',
      reloadNavigation,
    )
  })
  async function signOut(): Promise<void> {
    if (signingOut) return
    signingOut = true
    // 退出会立即清除身份；先记下当前工作台，让下一位注册者沿用这个入口。
    const entryProduct = product.value
    try {
      await mutation.run(() => auth.signOut())
      await router.replace({ path: '/login', query: { product: entryProduct } })
    } finally {
      signingOut = false
    }
  }
  return {
    product,
    productName,
    home,
    canSwitch,
    contextPath,
    auth,
    preferences,
    navigation,
    mutation,
    sidebar,
    mobileOpen,
    expanded,
    signOutOpen,
    module,
    permitted,
    items,
    entries,
    parent,
    title,
    tabs,
    label,
    path,
    signOut,
  }
}
