<script setup lang="ts">
import AppIcon from '@/components/base/AppIcon.vue'
import { usePreferences } from '@/store/modules/preferences'

/** 同一官网的章节共用动效偏好；按钮名称描述下一次操作。 */
const enabled = defineModel<boolean>({ required: true })
const { tr } = usePreferences()
</script>

<template>
  <button
    type="button"
    class="studio-motion-toggle"
    :aria-label="
      enabled
        ? tr('暂停背景动效', 'Pause background motion')
        : tr('播放背景动效', 'Play background motion')
    "
    @click="enabled = !enabled"
  >
    <AppIcon :name="enabled ? 'circle-pause' : 'circle-play'" />{{
      tr('动效', 'Motion')
    }}
  </button>
</template>
