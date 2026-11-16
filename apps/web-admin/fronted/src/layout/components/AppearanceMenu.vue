<script setup lang="ts">
import AppIcon from '@/components/base/AppIcon.vue'
import { usePreferences } from '@/store/modules/preferences'

/** 页头与个人外观设置共用同一个偏好，跟随系统时继续响应操作系统变化。 */
const preferences = usePreferences()
const choices = [
  { value: 'light', zh: '浅色', en: 'Light' },
  { value: 'dark', zh: '深色', en: 'Dark' },
  { value: 'system', zh: '跟随系统', en: 'System' },
] as const
</script>
<template>
  <el-dropdown
    trigger="click"
    @command="(value: typeof preferences.theme) => (preferences.theme = value)"
  >
    <button
      type="button"
      class="console-icon-button"
      :aria-label="preferences.tr('选择外观', 'Choose appearance')"
      :title="preferences.tr('选择外观', 'Choose appearance')"
    >
      <AppIcon
        :name="
          preferences.theme === 'dark'
            ? 'moon'
            : preferences.theme === 'light'
              ? 'sun'
              : 'monitor'
        "
      />
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="option in choices"
          :key="option.value"
          :command="option.value"
          role="menuitemradio"
          :aria-checked="preferences.theme === option.value"
        >
          <span>{{ preferences.tr(option.zh, option.en) }}</span>
          <AppIcon
            v-if="preferences.theme === option.value"
            name="check"
            :size="14"
          />
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>
