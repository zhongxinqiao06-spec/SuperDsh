<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { usePreferences } from '@/store/modules/preferences'
import type { NavigationDisplayItem } from '@/types/console/navigation'

/** 桌面侧栏和移动抽屉共用菜单展示；授权、请求与路由解析由布局用例提供。 */
const props = defineProps<{
  items: readonly NavigationDisplayItem[]
  expanded: string | null
  loading: boolean
  error: string
  fallback: boolean
  displayName: string
  roles: string
  canManageMenus: boolean
}>()
defineEmits<{
  toggleGroup: [id: string]
  navigate: []
  retry: []
  signOut: []
}>()
const preferences = usePreferences()
const roots = computed(() => props.items.filter((item) => !item.parentId))
</script>

<template>
  <div class="console-sidebar-content">
    <div class="sidebar-brand">
      <router-link to="/overview" @click="$emit('navigate')">
        {{ preferences.tr('星桥智能平台', 'Starbridge') }}
      </router-link>
      <p>{{ preferences.tr('统一管理平台', 'Management console') }}</p>
    </div>
    <nav
      class="console-navigation"
      :aria-label="preferences.tr('平台导航', 'Platform navigation')"
    >
      <ResourceStatus
        :loading="loading"
        :error="error"
        @retry="$emit('retry')"
      />
      <template v-for="item in roots" :key="item.id">
        <div v-if="item.kind === 'group'" class="nav-section">
          <button
            type="button"
            class="nav-group"
            :aria-expanded="expanded === item.id"
            @click="$emit('toggleGroup', item.id)"
          >
            <AppIcon :name="item.icon" />
            <span class="nav-label">{{ item.title }}</span>
            <AppIcon
              name="chevron-down"
              :size="14"
              class="nav-chevron"
              :class="{ 'nav-chevron-closed': expanded !== item.id }"
            />
          </button>
          <div v-show="expanded === item.id" class="nav-children">
            <router-link
              v-for="child in items.filter(
                (entry) => entry.parentId === item.id,
              )"
              :key="child.id"
              :to="child.path"
              class="nav-link"
              :class="{ active: child.active }"
              :aria-current="child.active ? 'page' : undefined"
              @click="$emit('navigate')"
            >
              <AppIcon :name="child.icon" />
              <span>{{ child.title }}</span>
            </router-link>
          </div>
        </div>
        <router-link
          v-else
          :to="item.path"
          class="nav-link"
          :class="{ active: item.active }"
          :aria-current="item.active ? 'page' : undefined"
          @click="$emit('navigate')"
        >
          <AppIcon :name="item.icon" />
          <span>{{ item.title }}</span>
        </router-link>
      </template>
      <router-link
        v-if="fallback"
        class="nav-fallback"
        to="/overview"
        @click="$emit('navigate')"
        >{{ preferences.tr('总览', 'Overview') }}</router-link
      >
    </nav>
    <div class="sidebar-footer">
      <router-link
        v-if="canManageMenus"
        to="/access/menus"
        class="menu-recovery"
        @click="$emit('navigate')"
      >
        <AppIcon name="menu" />
        {{ preferences.tr('菜单管理与恢复', 'Manage / restore navigation') }}
      </router-link>
      <div class="account-row">
        <router-link to="/account/profile" @click="$emit('navigate')">
          <strong>{{ displayName }}</strong>
          <small>{{ roles }}</small>
        </router-link>
        <button
          type="button"
          class="console-icon-button"
          :aria-label="preferences.tr('退出登录', 'Sign out')"
          @click="$emit('signOut')"
        >
          <AppIcon name="log-out" />
        </button>
      </div>
    </div>
  </div>
</template>
