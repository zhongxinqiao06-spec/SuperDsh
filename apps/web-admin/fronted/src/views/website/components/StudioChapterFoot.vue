<script setup lang="ts">
import AppIcon from '@/components/base/AppIcon.vue'
import StudioMotionToggle from './StudioMotionToggle.vue'

/** 章节结尾保留下一屏入口和共用的背景动效开关。 */
defineProps<{ label: string; showMotion: boolean }>()
const enabled = defineModel<boolean>({ required: true })
defineEmits<{ next: [] }>()
</script>

<template>
  <div class="studio-chapter-foot">
    <StudioMotionToggle v-if="showMotion" v-model="enabled" />
    <button type="button" class="studio-next" @click="$emit('next')">
      {{ label }}<AppIcon name="chevron-down" />
    </button>
  </div>
</template>
