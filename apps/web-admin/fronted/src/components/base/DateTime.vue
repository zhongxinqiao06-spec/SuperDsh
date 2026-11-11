<script setup lang="ts">
import { computed } from 'vue'
import { dateTimeParts } from '@/utils/date-time'
/** 日期和时间有意分行，完整本地时间保留在提示中。 */
const props = defineProps<{ value?: string | null }>()
const parts = computed(() => dateTimeParts(props.value))
</script>
<template>
  <time class="date-time" :datetime="value || undefined" :title="parts.full"
    ><span>{{ parts.date }}</span
    ><span v-if="parts.time">{{ parts.time }}</span></time
  >
</template>
