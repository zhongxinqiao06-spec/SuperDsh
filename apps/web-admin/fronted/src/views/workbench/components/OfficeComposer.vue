<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import type { useWorkbench } from '@/composables/workbench/use-workbench'
import { useAgentBinding } from '@/composables/workbench/use-agent-binding'
import { useAuthStore } from '@/store/modules/auth-store'
import {
  canComposeSession,
  canControlSession,
} from '@/utils/workbench/session-access'
import RuntimeSelectors from './RuntimeSelectors.vue'
import NewSessionSelectors from './NewSessionSelectors.vue'

/** 首页与会话页使用同一输入控制器，保留附件、模型选择与稳定的提交身份。 */
const props = defineProps<{
  workspace: ReturnType<typeof useWorkbench>
  home?: boolean
}>()
const workspace = props.workspace
const auth = useAuthStore()
const canSend = computed(
  () =>
    auth.can('sessions.run') &&
    auth.can('models.use') &&
    canComposeSession(workspace.snapshot.value?.session),
)
const canControl = computed(
  () =>
    auth.can('sessions.run') &&
    canControlSession(workspace.snapshot.value?.session),
)
const binding = useAgentBinding(
  workspace.selected,
  canSend,
  workspace.refreshSnapshot,
)
async function useServerAgent(): Promise<void> {
  await workspace.prepare()
  const agent = workspace.runtime.agent
  if (agent?.connectorId) {
    workspace.draft.value.deviceId = agent.connectorId
    workspace.project.value = agent.projectId ?? ''
  }
}
function selectFiles(event: Event): void {
  const input = event.target as HTMLInputElement
  workspace.draft.value.files.push(...Array.from(input.files ?? []))
  input.value = ''
}
</script>
<template>
  <el-alert
    v-if="binding.error.value"
    :title="binding.error.value"
    type="error"
    :closable="false"
  >
    <el-button link @click="binding.reload">重新加载绑定</el-button>
  </el-alert>
  <form class="composer" @submit.prevent="workspace.send">
    <el-input
      v-model="workspace.draft.value.text"
      aria-label="任务草稿"
      type="textarea"
      :autosize="{ minRows: 3, maxRows: 8 }"
      resize="none"
      :disabled="!canSend"
      :placeholder="home ? '描述任务，或添加资料开始……' : '描述你的任务…'"
    />
    <div class="draft-files">
      <el-tag
        v-for="(file, index) in workspace.draft.value.files"
        :key="`${file.name}:${index}`"
        closable
        @close="workspace.draft.value.files.splice(index, 1)"
        >{{ file.name }}</el-tag
      >
    </div>
    <el-progress
      v-if="workspace.uploadProgress.value"
      :percentage="workspace.uploadProgress.value"
    />
    <div class="composer-actions">
      <el-switch
        v-if="workspace.snapshot.value"
        :model-value="workspace.snapshot.value.session.takeover"
        :disabled="
          !auth.can('sessions.run') ||
          workspace.snapshot.value.session.archived ||
          workspace.takingOver.value
        "
        :loading="workspace.takingOver.value"
        aria-label="接管会话"
        active-text="接管"
        @change="workspace.toggleTakeover"
      />
      <label class="upload-label" title="添加附件"
        ><AppIcon name="paperclip" /><span class="workbench-sr-only"
          >添加附件</span
        ><input
          type="file"
          aria-label="添加附件"
          multiple
          :disabled="!canSend || workspace.sending.value"
          @change="selectFiles"
      /></label>
      <div class="composer-options">
        <NewSessionSelectors
          v-if="!workspace.selected.value"
          v-model:device-id="workspace.draft.value.deviceId"
          v-model:agent-id="workspace.agentId.value"
          :devices="workspace.devices.value"
          :agents="workspace.agents.value"
          :runtime="workspace.runtime.agent"
          :stalled="workspace.runtimeReadiness.stalled.value"
          :busy="workspace.runtime.busy"
          :can-manage="auth.can('devices.manage')"
          :disabled="!canSend || workspace.sending.value"
          @update:device-id="workspace.project.value = ''"
          @prepare="useServerAgent"
          @reload="workspace.reload"
        />
        <el-select
          v-if="workspace.selected.value"
          :model-value="binding.current.value"
          :disabled="!canSend || binding.loading.value || binding.saving.value"
          aria-label="会话智能体"
          placeholder="通用对话"
          @change="binding.change"
        >
          <el-option value="" label="通用对话" disabled />
          <el-option
            v-for="agent in workspace.agents.value"
            :key="agent.id"
            :value="agent.id"
            :label="agent.name"
          />
        </el-select>
        <RuntimeSelectors
          :selection="workspace.runtimeSelections"
          :existing="!!workspace.selected.value"
          :disabled="
            !auth.can('sessions.run') ||
            !auth.can('models.use') ||
            workspace.sending.value
          "
        />
      </div>
      <el-button
        v-if="
          ['running', 'starting', 'waiting_approval', 'waiting_input'].includes(
            workspace.snapshot.value?.session.status ?? '',
          )
        "
        type="danger"
        class="composer-stop"
        aria-label="中断任务"
        :disabled="!canControl || workspace.interrupting.value"
        :loading="workspace.interrupting.value"
        @click="workspace.interrupt"
        ><AppIcon name="square" /><span>{{
          workspace.interrupting.value ? '正在终止' : '中断任务'
        }}</span></el-button
      ><el-button
        type="primary"
        class="composer-send"
        :class="{ 'composer-send-home': home }"
        aria-label="发送"
        native-type="submit"
        :loading="workspace.sending.value"
        :disabled="
          !canSend ||
          (!workspace.draft.value.text.trim() &&
            !workspace.draft.value.files.length)
        "
        ><span v-if="home">开始任务</span
        ><AppIcon :name="home ? 'arrow-right' : 'arrow-up'"
      /></el-button>
    </div>
  </form>
</template>
