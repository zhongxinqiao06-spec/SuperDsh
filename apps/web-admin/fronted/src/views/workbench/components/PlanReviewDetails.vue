<script setup lang="ts">
import { computed } from 'vue'
import type { PlanRecord } from '@/api/workbench/record-api'
import { objectValue } from '@/utils/workbench/timeline'

/** 审批先呈现真实方案与输入，复杂参数可展开检查；不推断或执行工具能力。 */
const props = defineProps<{ plan: PlanRecord }>()
const fields = computed(() =>
  Object.entries(
    props.plan.document.arguments === undefined
      ? props.plan.document
      : objectValue(props.plan.document.arguments),
  ).filter(([key]) => !['title', 'summary'].includes(key)),
)
const labels: Record<string, string> = {
  name: '名称',
  description: '说明',
  kind: '类型',
  operation: '操作',
  action: '操作',
  prompt: '生成要求',
}
</script>
<template>
  <section class="plan-review-details" aria-label="本次执行方案">
    <strong>{{ plan.title }}</strong>
    <p v-if="plan.summary">{{ plan.summary }}</p>
    <dl v-if="fields.length">
      <template v-for="[key, value] in fields" :key="key">
        <dt>{{ labels[key] ?? key }}</dt>
        <dd>
          <details v-if="value !== null && typeof value === 'object'">
            <summary>查看完整参数</summary>
            <pre>{{ JSON.stringify(value, null, 2) }}</pre>
          </details>
          <span v-else>{{ value === null ? '未设置' : String(value) }}</span>
        </dd>
      </template>
    </dl>
    <p v-else>此方案没有额外输入参数。</p>
  </section>
</template>
<style scoped>
.plan-review-details {
  display: grid;
  gap: var(--control-gap);
  min-width: 0;
}
.plan-review-details p {
  margin: 0;
  color: var(--muted-foreground);
}
.plan-review-details dl {
  margin: 0;
  display: grid;
  grid-template-columns: minmax(64px, auto) minmax(0, 1fr);
  gap: var(--control-gap) var(--field-gap);
}
.plan-review-details dt {
  color: var(--muted-foreground);
}
.plan-review-details dd {
  margin: 0;
}
.plan-review-details dd,
.plan-review-details p,
.plan-review-details strong {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.plan-review-details pre {
  margin: var(--control-gap) 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--font-size-meta);
}
@media (max-width: 420px) {
  .plan-review-details dl {
    grid-template-columns: minmax(0, 1fr);
  }
  .plan-review-details dd {
    margin-bottom: var(--control-gap);
  }
}
</style>
