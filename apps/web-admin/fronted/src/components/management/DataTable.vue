<script setup lang="ts">
/** 原生数据表公共容器保留表格语义；窄屏插槽承接同一份数据和操作。 */
defineProps<{
  tableClass?: string
  label?: string
  busy?: boolean
  mobileCards?: boolean
}>()
</script>
<template>
  <div
    class="data-table-shell"
    :class="{
      'has-mobile-view': Boolean($slots.mobile),
      'has-card-rows': mobileCards,
    }"
    :aria-busy="busy || undefined"
  >
    <div class="table-wrap" :aria-label="label" role="region" tabindex="0">
      <table class="data-table" :class="tableClass">
        <slot />
      </table>
    </div>
    <div v-if="$slots.mobile" class="data-table-mobile">
      <slot name="mobile" />
    </div>
  </div>
</template>
