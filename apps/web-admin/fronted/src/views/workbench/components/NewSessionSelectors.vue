<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import type { ServerAgent } from '@/api/workbench/runtime-api'
import type { AgentDefinition } from '@/types/agents/agents'
import type { WorkspaceConnector } from '@/types/workbench/models'

/** 新会话的设备与智能体入口；仅展示状态并发出操作，不自行准备引擎或读取目录。 */
const props = defineProps<{
  deviceId: string
  agentId: string
  devices: WorkspaceConnector[]
  agents: AgentDefinition[]
  runtime: ServerAgent | null
  stalled: boolean
  busy: boolean
  canManage: boolean
  disabled: boolean
}>()
defineEmits<{
  'update:deviceId': [value: string]
  'update:agentId': [value: string]
  prepare: []
  reload: []
}>()
const status = computed(() =>
  props.stalled
    ? '状态待确认'
    : props.runtime?.status === 'running'
      ? '已就绪'
      : props.runtime?.status === 'starting'
        ? '准备中'
        : props.runtime?.status === 'error'
          ? '准备失败'
          : '未准备',
)
const action = computed(() =>
  props.stalled
    ? '刷新状态'
    : props.runtime?.status === 'running'
      ? '使用服务端 Agent'
      : '准备服务端 Agent',
)
const serverSelected = computed(
  () =>
    !props.deviceId ||
    props.runtime?.connectorId === props.deviceId ||
    props.devices.find((device) => device.id === props.deviceId)
      ?.executorKind === 'server-agent',
)
</script>

<template>
  <el-select
    :model-value="deviceId"
    aria-label="执行设备"
    placeholder="服务端 Agent"
    class="composer-device-select"
    popper-class="composer-config-menu"
    placement="top-start"
    :fit-input-width="false"
    :disabled="disabled"
    @change="(value: string) => $emit('update:deviceId', value)"
  >
    <template #prefix>
      <span
        v-if="serverSelected"
        class="composer-runtime-status"
        :data-status="stalled ? 'unknown' : runtime?.status"
        role="status"
        :aria-label="`服务端 Agent：${status}`"
        :title="`服务端 Agent：${status}`"
        ><span class="workbench-sr-only">{{ status }}</span></span
      >
      <AppIcon v-else name="monitor" />
    </template>
    <template #header>
      <div class="composer-config-heading">
        <strong>执行设备</strong>
        <span>DSH</span>
      </div>
    </template>
    <el-option
      v-for="device in devices"
      :key="device.id"
      :value="device.id"
      :label="
        device.executorKind === 'server-agent' ? '服务端 Agent' : device.name
      "
      :disabled="device.status !== 'online'"
    />
    <template #footer>
      <div class="composer-config-heading">
        <strong><AppIcon name="server" />服务端 Agent</strong>
        <span class="server-agent-state">{{ status }}</span>
      </div>
      <p>无需连接电脑，手机、网页和桌面共用会话。个人模型在设置中配置。</p>
      <el-button v-if="canManage" :loading="busy" @click="$emit('prepare')">{{
        action
      }}</el-button>
    </template>
  </el-select>
  <el-select
    :model-value="agentId"
    class="composer-agent-select"
    popper-class="composer-config-menu"
    clearable
    placeholder="通用对话"
    aria-label="智能体选择"
    placement="top-start"
    :fit-input-width="false"
    :disabled="disabled"
    @change="(value: string) => $emit('update:agentId', value)"
  >
    <template #prefix><AppIcon name="bot" /></template>
    <template #header>
      <div class="composer-config-heading"><strong>业务智能体</strong></div>
      <p>使用已发布智能体配置的知识、模板、技能和工具。</p>
    </template>
    <el-option value="" label="通用对话" />
    <el-option
      v-for="agent in agents"
      :key="agent.id"
      :value="agent.id"
      :label="agent.name"
    />
    <template #footer>
      <el-button text @click="$emit('reload')"
        ><AppIcon name="refresh-cw" />刷新智能体</el-button
      >
    </template>
  </el-select>
</template>
