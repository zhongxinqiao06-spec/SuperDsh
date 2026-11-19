<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useDirectorChat } from '@/composables/studio/use-director-chat'
import type { SeriesProposal } from '@/types/studio/series'
import InteractionCard from '@/views/workbench/components/InteractionCard.vue'
import { errorMessage } from '@/utils/errors'

/** 用户明确发起后才发送 DSH 指令；恢复页面只读状态，不自动重提。 */
const props = defineProps<{
  proposal: SeriesProposal
  autoStart?: boolean
  allowed: boolean
}>()
const emit = defineEmits<{ sent: []; busy: [boolean] }>()
const stopping = ref(false)
const chat = useDirectorChat({
  project: props.proposal.projectId,
  existing: () => null,
  active: () => true,
  allowed: () => props.allowed,
  save: async () => {},
})
async function send() {
  emit('busy', true)
  try {
    if (
      await chat.send(
        props.proposal.prompt,
        'series-proposal-' + props.proposal.id,
      )
    )
      emit('sent')
  } finally {
    emit('busy', false)
  }
}
onMounted(() => {
  if (props.autoStart && props.proposal.state === 'waiting') void send()
})
async function stop() {
  if (stopping.value) return
  stopping.value = true
  try {
    await chat.interrupt()
  } catch (cause) {
    chat.error.value = errorMessage(cause)
  } finally {
    stopping.value = false
  }
}
</script>
<template>
  <div class="form-stack">
    <p v-if="chat.progress.value" role="status" class="studio-meta">
      {{ chat.progress.value }}
    </p>
    <el-alert
      v-if="chat.error.value"
      :title="chat.error.value"
      type="error"
      :closable="false"
    />
    <InteractionCard
      v-for="item in [
        ...(chat.snapshot.value?.notices ?? []),
        ...(chat.snapshot.value?.approvals ?? []),
      ].filter((item) =>
        ['open', 'responding'].includes(String(item.status ?? 'open')),
      )"
      :key="item.id"
      :notice="item"
      :session-id="chat.session.value"
      :disabled="!allowed || chat.busy.value"
      @respond="chat.respond"
    />
    <div class="toolbar">
      <el-button
        v-if="proposal.state === 'waiting' && !chat.running.value"
        :loading="chat.busy.value"
        :disabled="!allowed"
        @click="send"
        >继续发送本次请求</el-button
      >
      <el-button
        v-if="chat.bindingOutdated.value"
        :disabled="chat.busy.value"
        @click="chat.refreshBinding"
        >更新助手工具</el-button
      >
      <el-button
        v-if="chat.running.value"
        :disabled="!allowed || stopping"
        :loading="stopping"
        @click="stop"
        >停止助手</el-button
      >
    </div>
  </div>
</template>
