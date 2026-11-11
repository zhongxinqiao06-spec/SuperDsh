<script setup lang="ts">
import { toRef } from 'vue'
import { useSharing } from '@/composables/workbench/use-sharing'
/** 公开分享的创建、复制与撤销入口，组件不持有会话内容。 */
const props = defineProps<{ sessionId: string }>()
const sharing = useSharing(toRef(props, 'sessionId'))
defineExpose({ show: sharing.show })
</script>
<template>
  <el-dialog
    v-model="sharing.open.value"
    :title="sharing.messageId.value ? '分享此回复' : '会话分享'"
    width="650px"
    class="session-share-dialog"
  >
    <el-alert
      v-if="sharing.error.value"
      :title="sharing.error.value"
      type="error"
      :closable="false"
    />
    <p class="session-share-description">
      {{
        sharing.messageId.value
          ? '此链接只包含所选回复及其附件。'
          : '每个链接只包含创建时的消息和附件快照。'
      }}
    </p>
    <el-button
      type="primary"
      :loading="sharing.busy.value"
      @click="sharing.create"
      >创建分享链接</el-button
    >
    <div v-for="item in sharing.items.value" :key="item.id" class="share-row">
      <span
        >{{ item.createdAt }} · {{ item.revokedAt ? '已撤销' : '有效' }}</span
      >
      <el-input
        v-if="!item.revokedAt"
        :model-value="sharing.url(item)"
        readonly
        aria-label="分享链接"
      />
      <el-button
        v-if="!item.revokedAt"
        type="danger"
        text
        :disabled="sharing.busy.value"
        @click="sharing.revoke(item.id)"
        >撤销</el-button
      >
    </div>
    <el-empty v-if="!sharing.items.value.length" description="尚未创建分享" />
  </el-dialog>
</template>
