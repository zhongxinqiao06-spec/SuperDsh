<script setup lang="ts">
import { useAuthStore } from '@/store/modules/auth-store'
import { supplierPlan } from '@/utils/models/supplier-presentation'
import type { ModelConfiguration, ModelConnection } from '@/types/models/models'

/** 目录只呈现当前产品已授权的连接，详情与凭据分别进入独立界面。 */
defineProps<{
  connections: ModelConnection[]
  configurations: ModelConfiguration[]
}>()
const emit = defineEmits<{
  edit: [value: ModelConnection | 'new']
  detail: [id: string]
  reveal: [value: ModelConnection]
}>()
const auth = useAuthStore()
</script>
<template>
  <section class="supplier-directory" aria-label="平台供应商">
    <div class="toolbar">
      <h2>平台供应商</h2>
      <el-button @click="emit('edit', 'new')">新增连接</el-button>
    </div>
    <div class="supplier-grid">
      <article v-for="c in connections" :key="c.id" class="supplier-card">
        <div class="supplier-title">
          <h3>{{ c.name }}</h3>
          <el-tag size="small" :type="c.enabled ? 'success' : 'info'">{{
            c.enabled ? '启用' : '停用'
          }}</el-tag>
        </div>
        <div class="supplier-facts">
          <span>{{ c.subscription?.plan || supplierPlan(c).plan }}</span
          ><span
            >{{
              configurations.filter((m) => m.connectionId === c.id).length
            }}
            项模型配置</span
          ><span>{{
            c.credentialConfigured ? 'Key 已配置' : '待配置 Key'
          }}</span>
          <span v-if="c.subscription?.remaining != null"
            >登记剩余 {{ c.subscription.remaining }}
            {{ c.subscription.unit }}</span
          >
        </div>
        <div class="supplier-actions">
          <el-button
            :id="'supplier-detail-trigger-' + c.id"
            link
            type="primary"
            @click="emit('detail', c.id)"
            >套餐、额度与模型</el-button
          ><el-button link @click="emit('edit', c)">编辑连接</el-button
          ><el-button
            v-if="
              c.credentialConfigured && auth.session?.roles.includes('admin')
            "
            link
            @click="emit('reveal', c)"
            >查看 Key</el-button
          >
        </div>
      </article>
    </div>
  </section>
</template>
<style scoped>
.supplier-directory {
  display: grid;
  gap: var(--space-3);
}
.supplier-directory h2,
.supplier-title h3 {
  margin: 0;
  font: 600 var(--sheet-section-size)/1.4 var(--sheet-font);
}
.supplier-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: var(--space-3, 12px);
}
.supplier-card {
  min-width: 0;
  border: 1px solid var(--border);
  background: var(--el-bg-color);
  border-radius: var(--el-border-radius-base);
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3, 12px);
}
.supplier-title,
.supplier-actions,
.supplier-facts {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex-wrap: wrap;
  overflow-wrap: anywhere;
}
.supplier-title {
  justify-content: space-between;
}
.supplier-facts {
  color: var(--muted-foreground);
  font-size: 0.85rem;
}
.supplier-actions .el-button {
  margin: 0;
}
@media (max-width: 700px) {
  .supplier-grid {
    grid-auto-flow: column;
    grid-template-columns: none;
    grid-auto-columns: min(86%, 320px);
    overflow-x: auto;
    scroll-snap-type: x proximity;
  }
  .supplier-card {
    scroll-snap-align: start;
  }
}
</style>
