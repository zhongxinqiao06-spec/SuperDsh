<script setup lang="ts">
import { computed, inject } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import OfficeHomeComposer from './components/OfficeHomeComposer.vue'
import OfficeDeliverables from './components/OfficeDeliverables.vue'
import OfficeRecentSessions from './components/OfficeRecentSessions.vue'
import { consoleMenuKey } from '@/layout/console-navigation'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import { consoleModules } from '@/utils/console/modules'
import '@/assets/styles/office-home.css'

/** 快捷入口来自当前产品可见菜单，展示权限与路由权限同步。 */
const items = inject(consoleMenuKey)
const auth = useAuthStore()
const { tr } = usePreferences()
const shown = (id: string) =>
  !!items?.value.some((item) => item.moduleId === id)
const shortcuts = computed(() =>
  [
    ['workbench', tr('办公工作台', 'Office workspace')],
    ['knowledge', tr('知识库', 'Knowledge bases')],
    ['account.files', tr('文件与交付物', 'Files and deliverables')],
    ['overview', tr('管理后台', 'Management console')],
  ].flatMap(([id, label]) => {
    const module = consoleModules.find((entry) => entry.id === id)
    const item = items?.value.find((entry) => entry.moduleId === id)
    return module && item
      ? [
          {
            path: module.path,
            label: item.title === module.title ? label : item.title,
            icon: item.icon,
          },
        ]
      : []
  }),
)
</script>
<template>
  <section class="office-home">
    <div class="office-home-grid">
      <section class="office-intro">
        <h1>
          {{ tr('今天，想完成什么？', 'What would you like to do today?') }}
        </h1>
        <p class="office-lead">
          {{
            tr(
              '描述任务，或添加资料开始。',
              'Describe a task or add your source files.',
            )
          }}
        </p>
        <OfficeHomeComposer
          v-if="shown('workbench') && auth.can('models.use')"
        />
        <nav
          v-if="shortcuts.length"
          class="office-shortcuts"
          aria-label="办公快捷入口"
        >
          <router-link
            v-for="link in shortcuts"
            :key="link.path"
            :to="link.path"
            ><AppIcon :name="link.icon" :size="15" />{{
              link.label
            }}</router-link
          >
        </nav>
      </section>
      <OfficeDeliverables
        v-if="auth.can('files.read') && auth.can('sessions.read')"
      />
      <OfficeRecentSessions
        v-if="shown('office.history') && auth.can('sessions.read')"
        :can-open="shown('workbench')"
      />
    </div>
  </section>
</template>
