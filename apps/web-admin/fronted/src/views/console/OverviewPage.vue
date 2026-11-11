<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed } from 'vue'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import { canOpenModule, consoleModules } from '@/utils/console/modules'
import DashboardPanel from '@/views/console/components/DashboardPanel.vue'
import AppIcon from '@/components/base/AppIcon.vue'
/** 总览展示真实身份和授权入口，不伪造尚未迁移的统计数据。 */
const auth = useAuthStore(),
  preferences = usePreferences()
const links = computed(() =>
  consoleModules.filter(
    (item) =>
      [
        'workbench',
        'account.profile',
        'account.security',
        'account.models',
      ].includes(item.id) &&
      canOpenModule(item, auth.session?.permissions ?? []),
  ),
)
</script>

<template>
  <DashboardPanel v-if="auth.can('settings.manage')" />
  <section v-else class="page overview-page">
    <PageHeader :title="preferences.tr('总览', 'Overview')" />
    <div class="panel">
      <h2>
        {{ preferences.tr('欢迎回来', 'Welcome back') }}，{{
          auth.session?.displayName || auth.session?.username
        }}
      </h2>
      <dl class="summary">
        <div>
          <dt>{{ preferences.tr('用户名', 'Username') }}</dt>
          <dd>{{ auth.session?.username }}</dd>
        </div>
        <div>
          <dt>{{ preferences.tr('角色', 'Roles') }}</dt>
          <dd>{{ auth.session?.roles.join(', ') }}</dd>
        </div>
        <div>
          <dt>{{ preferences.tr('账号状态', 'Account status') }}</dt>
          <dd>{{ preferences.tr('正常', 'Active') }}</dd>
        </div>
      </dl>
    </div>
    <div class="quick-links">
      <router-link v-for="item in links" :key="item.id" :to="item.path"
        ><AppIcon :name="item.icon" />{{
          preferences.tr(item.title, item.englishTitle)
        }}</router-link
      >
    </div>
  </section>
</template>
