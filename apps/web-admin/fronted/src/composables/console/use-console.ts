import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/store/modules/auth-store'
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
import { navigationGroups } from '@/utils/console/navigation-display'

/** 后台壳只读取身份与菜单，定时刷新撤权状态，不触发工作台运行服务。 */
export function useConsole() {
  const auth = useAuthStore(),
    route = useRoute(),
    router = useRouter(),
    preferences = usePreferences()
  const navigation = useResource(navigationApi.get),
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
      module.value &&
      canOpenModule(module.value, auth.session?.permissions ?? []),
    ),
  )
  const items = computed(() =>
    visibleNavigation(
      navigation.data.value?.items ?? [],
      auth.session?.permissions ?? [],
      auth.session?.roles ?? [],
    ),
  )
  const activeItem = computed(() =>
    items.value.find((item) => item.moduleId === module.value?.id),
  )
  const parent = computed(() =>
    items.value.find((item) => item.id === activeItem.value?.parentId),
  )
  const title = computed(() =>
    activeItem.value
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
        active: item.moduleId === module.value?.id,
      })),
  )
  const abort = new AbortController()
  let timer: ReturnType<typeof setInterval> | null = null
  const reloadNavigation = () => {
    void navigation.reload()
  }
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
    return (
      consoleModules.find((entry) => entry.id === item.moduleId)?.path ??
      '/overview'
    )
  }
  watch([() => module.value?.id, () => navigation.data.value?.version], () => {
    const selected = items.value.find(
      (item) => item.moduleId === module.value?.id,
    )
    if (selected?.parentId) expanded.value = selected.parentId
  })
  watch(
    () => route.fullPath,
    () => {
      mobileOpen.value = false
    },
  )
  watch(
    () => auth.authenticated,
    (value) => {
      if (!value) void router.replace('/login')
    },
  )
  watch(
    () => auth.session?.authzVersion,
    () => {
      if (auth.authenticated) reloadNavigation()
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
    await mutation.run(() => auth.signOut())
    await router.replace('/login')
  }
  return {
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
    label,
    path,
    signOut,
  }
}
