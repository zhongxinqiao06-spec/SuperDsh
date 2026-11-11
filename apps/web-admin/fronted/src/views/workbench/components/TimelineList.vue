<script setup lang="ts">
import MarkdownContent from '@/components/MarkdownContent.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { messageText, objectValue } from '@/utils/workbench/timeline'
import type { TimelineItem } from '@/types/workbench/models'

/** 纯展示时间线；工具结果按结构折叠，活动 HTML 不会执行。 */
defineProps<{ items: TimelineItem[]; hasMore?: boolean; canShare?: boolean }>()
defineEmits<{
  older: []
  attachment: [fileId: string]
  share: [itemId: string]
}>()
function label(item: TimelineItem): string {
  const role = item.role ?? objectValue(item.content).role
  if (role === 'user' || item.type.includes('user')) return '你'
  if (role === 'assistant' || item.type.includes('assistant')) return 'Agent'
  if (item.type.includes('tool')) return '工具调用'
  if (item.type === 'turn.start') return '任务开始'
  if (item.type === 'turn.end') return '任务结束'
  return item.type
}
function attachments(item: TimelineItem): Record<string, unknown>[] {
  const raw = objectValue(item.content).attachments ?? item.attachments
  return Array.isArray(raw)
    ? raw.map(objectValue).filter((value) => typeof value.fileId === 'string')
    : []
}
</script>

<template>
  <section class="timeline-list" aria-live="polite" aria-label="会话消息">
    <el-button v-if="hasMore" text @click="$emit('older')"
      >加载更早的消息</el-button
    >
    <p v-if="!items.length" class="timeline-empty">
      任务提交后，消息与工具结果将在这里持续更新
    </p>
    <article
      v-for="item in items"
      :key="item.id"
      class="timeline-item"
      :data-kind="label(item)"
    >
      <header>
        <strong>{{ label(item) }}</strong
        ><small v-if="item.pending">发送中…</small
        ><small v-if="typeof item.createdAt === 'string'">{{
          item.createdAt
        }}</small>
      </header>
      <MarkdownContent v-if="messageText(item)" :content="messageText(item)" />
      <el-button
        v-if="canShare && label(item) === 'Agent' && !item.pending"
        text
        aria-label="分享此回复"
        @click="$emit('share', item.id)"
        ><AppIcon name="share-2" />分享此回复</el-button
      >
      <details v-if="item.type.includes('tool') || !messageText(item)">
        <summary>
          <AppIcon
            :name="item.type.includes('tool') ? 'terminal' : 'file-text'"
          />
          查看{{ item.type.includes('tool') ? '工具详情' : '事件详情' }}
        </summary>
        <pre>{{ JSON.stringify(item.content ?? item, null, 2) }}</pre>
      </details>
      <div v-if="attachments(item).length" class="attachment-list">
        <el-button
          v-for="attachment in attachments(item)"
          :key="String(attachment.fileId)"
          text
          @click="$emit('attachment', String(attachment.fileId))"
          >{{ attachment.name ?? attachment.fileId }}</el-button
        >
      </div>
    </article>
  </section>
</template>
