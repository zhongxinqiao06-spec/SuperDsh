<script setup lang="ts">
import { computed, provide, watch } from 'vue'
import { consoleMenuKey } from '@/layout/console-navigation'
import { useConsole } from '@/composables/console/use-console'
import PageHeader from '@/components/layout/PageHeader.vue'
import '@/assets/styles/member-directory.css'
import AppIcon from '@/components/base/AppIcon.vue'
import AnnouncementGate from '@/components/AnnouncementGate.vue'
import RegistrationCardGate from '@/views/billing/components/RegistrationCardGate.vue'
import ConsoleSidebar from '@/layout/components/ConsoleSidebar.vue'
import AppearanceMenu from '@/layout/components/AppearanceMenu.vue'
import '@/assets/styles/console.css'
import { roleLabel } from '@/utils/access/role-labels'

/** 产品拥有后台根布局；桌面和移动导航共用展示，菜单与路由权限分别判断。 */
const vm = useConsole()
provide(consoleMenuKey, vm.items)
// 浮层挂到 body，产品语义要覆盖整份文档；离开控制台即恢复公共入口的配色。
watch(
  vm.product,
  (product, _, onCleanup) => {
    if (!product) return
    document.documentElement.dataset.consoleProduct = product
    onCleanup(() => {
      delete document.documentElement.dataset.consoleProduct
    })
  },
  { immediate: true, flush: 'sync' },
)
const sidebarProps = computed(() => ({
  brand: vm.productName.value,
  product: vm.product.value,
  home: vm.home.value,
  menuPath: vm.contextPath('/access/menus'),
  accountPath: vm.contextPath('/account/profile'),
  items: vm.entries.value,
  expanded: vm.expanded.value,
  loading: vm.navigation.loading.value && !vm.navigation.data.value,
  error: vm.navigation.error.value,
  fallback: !vm.navigation.data.value,
  displayName: vm.auth.session?.displayName || vm.auth.session?.username || '—',
  roles:
    vm.auth.session?.roles
      .map((id) => roleLabel(id, vm.preferences.tr))
      .join('、') || '',
  canManageMenus:
    vm.auth.can('menus.read') ||
    vm.auth.can('menus.manage') ||
    (vm.product.value &&
      vm.auth.can('products.' + vm.product.value + '.menus.manage')) ||
    false,
}))
function toggleGroup(id: string): void {
  vm.expanded.value = vm.expanded.value === id ? null : id
}
</script>

<template>
  <div
    class="console-shell"
    :class="{ 'sidebar-collapsed': !vm.sidebar.value }"
    data-console-shell
  >
    <aside id="console-desktop-navigation" class="console-sidebar">
      <ConsoleSidebar
        v-bind="sidebarProps"
        @toggle-group="toggleGroup"
        @navigate="vm.mobileOpen.value = false"
        @retry="vm.navigation.reload"
        @sign-out="vm.signOutOpen.value = true"
      />
    </aside>
    <el-drawer
      v-model="vm.mobileOpen.value"
      class="console-sidebar-drawer"
      modal-class="console-navigation-overlay"
      direction="ltr"
      size="var(--navigation-drawer-width)"
      :title="vm.preferences.tr('平台导航', 'Platform navigation')"
      :with-header="false"
      :show-close="false"
      append-to-body
    >
      <ConsoleSidebar
        v-bind="sidebarProps"
        @toggle-group="toggleGroup"
        @navigate="vm.mobileOpen.value = false"
        @retry="vm.navigation.reload"
        @sign-out="vm.signOutOpen.value = true"
      />
      <button
        type="button"
        class="console-icon-button mobile-navigation-close"
        :aria-label="vm.preferences.tr('关闭导航', 'Close navigation')"
        @click="vm.mobileOpen.value = false"
      >
        <AppIcon name="x" />
      </button>
    </el-drawer>
    <div class="console-main">
      <header class="console-header">
        <button
          type="button"
          class="console-icon-button desktop-toggle"
          :aria-label="vm.preferences.tr('切换导航', 'Toggle navigation')"
          :aria-expanded="vm.sidebar.value"
          aria-controls="console-desktop-navigation"
          @click="vm.sidebar.value = !vm.sidebar.value"
        >
          <AppIcon name="panel-left" />
        </button>
        <button
          type="button"
          class="console-icon-button mobile-toggle"
          :aria-label="vm.preferences.tr('打开导航', 'Open navigation')"
          :aria-expanded="vm.mobileOpen.value"
          @click="vm.mobileOpen.value = true"
        >
          <AppIcon name="panel-left" />
        </button>
        <nav
          class="console-breadcrumb"
          :aria-label="vm.preferences.tr('面包屑', 'Breadcrumb')"
        >
          <router-link :to="vm.home.value">{{
            vm.productName.value
          }}</router-link>
          <span class="breadcrumb-separator" aria-hidden="true">/</span>
          <template v-if="vm.parent.value">
            <span class="breadcrumb-parent">{{
              vm.label(vm.parent.value)
            }}</span>
            <span class="breadcrumb-separator" aria-hidden="true">/</span>
          </template>
          <template v-if="$route.meta.studioCreation">
            <router-link :to="vm.home.value">{{ vm.title.value }}</router-link>
            <span class="breadcrumb-separator" aria-hidden="true">/</span>
            <span class="breadcrumb-current" aria-current="page">{{
              $route.meta.studioCreation === 'series'
                ? vm.preferences.tr('新建系列短剧', 'New series')
                : $route.meta.studioCreation === 'storyboard'
                  ? vm.preferences.tr('新建分镜作品', 'New storyboard')
                  : vm.preferences.tr('快速创作', 'Quick creation')
            }}</span>
          </template>
          <template v-else-if="$route.meta.projectEditor">
            <router-link to="/entertainment/works">{{
              vm.title.value
            }}</router-link>
            <span class="breadcrumb-separator" aria-hidden="true">/</span>
            <span class="breadcrumb-current" aria-current="page">{{
              vm.preferences.tr('作品工作台', 'Project workspace')
            }}</span>
          </template>
          <span v-else class="breadcrumb-current" aria-current="page">{{
            vm.title.value
          }}</span>
        </nav>
        <div class="console-header-actions">
          <AppearanceMenu />
          <router-link
            v-if="vm.canSwitch.value"
            class="console-product-switch"
            to="/products"
          >
            <AppIcon name="arrow-left-right" />
            <span>{{ vm.preferences.tr('切换产品', 'Switch product') }}</span>
          </router-link>
        </div>
      </header>
      <main
        class="console-content"
        :class="{
          'console-content-workbench': vm.module.value?.id === 'workbench',
        }"
        data-console-content
      >
        <el-alert
          v-if="vm.auth.session?.resetRequired"
          :title="
            vm.preferences.tr(
              '请先修改初始密码',
              'Please change your initial password',
            )
          "
          type="warning"
          :closable="false"
        >
          <template #default>
            <router-link :to="vm.contextPath('/account/security')">{{
              vm.preferences.tr('前往账号安全', 'Account security')
            }}</router-link>
          </template>
        </el-alert>
        <div
          v-if="vm.permitted.value && vm.inDirectory.value"
          class="member-directory-heading management-page"
        >
          <PageHeader
            :title="vm.preferences.tr('成员与账号', 'Members and accounts')"
          />
        </div>
        <nav
          v-if="
            vm.permitted.value &&
            (vm.tabs.value.length > 1 || vm.inDirectory.value)
          "
          class="console-context-tabs"
          :aria-label="vm.preferences.tr('相关设置', 'Related settings')"
        >
          <router-link
            v-for="tab in vm.tabs.value"
            :key="tab.id"
            :to="tab.path"
            :aria-current="tab.id === vm.module.value?.id ? 'page' : undefined"
            >{{ tab.title }}</router-link
          >
        </nav>
        <router-view
          v-if="vm.permitted.value"
          :key="`${vm.auth.generation}:${vm.product.value}:${vm.module.value?.id}:${$route.meta.studioCreation ?? ''}:${$route.params.project ?? $route.params.id ?? ''}`"
        />
        <div v-else class="console-route-message" role="alert">
          <h1>{{ vm.module.value ? '403' : '404' }}</h1>
          <p>
            {{
              vm.module.value
                ? vm.preferences.tr(
                    '当前账号没有访问此功能的权限。',
                    'Your account cannot access this feature.',
                  )
                : vm.preferences.tr(
                    '没有找到这个页面，请从左侧菜单选择功能。',
                    'This page does not exist. Choose a module from the navigation.',
                  )
            }}
          </p>
          <router-link :to="vm.home.value" class="console-route-return">{{
            vm.preferences.tr('返回首页', 'Back to home')
          }}</router-link>
        </div>
      </main>
    </div>
    <RegistrationCardGate
      v-if="vm.auth.session && !vm.auth.session.resetRequired"
      :key="vm.auth.session.userId"
      :cards-path="vm.contextPath('/account/cards')"
    >
      <AnnouncementGate />
    </RegistrationCardGate>
    <AnnouncementGate v-else :key="vm.auth.session?.userId" />
    <el-dialog
      v-model="vm.signOutOpen.value"
      :title="vm.preferences.tr('退出登录', 'Sign out')"
      width="min(440px,94vw)"
    >
      <p>
        {{
          vm.preferences.tr(
            '确认退出当前账号？未提交的本地草稿将被清除，已提交的服务端任务继续运行。',
            'Sign out and clear your unsent local drafts? Submitted server tasks continue running.',
          )
        }}
      </p>
      <template #footer>
        <el-button @click="vm.signOutOpen.value = false">{{
          vm.preferences.tr('取消', 'Cancel')
        }}</el-button>
        <el-button
          type="primary"
          :loading="vm.mutation.busy.value"
          @click="vm.signOut"
          >{{ vm.preferences.tr('确认退出', 'Sign out') }}</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>
