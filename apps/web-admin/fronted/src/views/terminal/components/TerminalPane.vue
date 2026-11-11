<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import { ref, toRef } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import '@xterm/xterm/css/xterm.css'
import { useTerminal } from '@/composables/terminal/use-terminal'
/** 真正的 PTY 终端展示，面板隐藏保留服务端实例。 */
const props = defineProps<{ connectorId: string; root?: string }>()
const host = ref<HTMLElement | null>(null)
const terminal = useTerminal(
  toRef(props, 'connectorId'),
  host,
  toRef(props, 'root'),
)
</script>

<template>
  <section class="terminal-pane">
    <div class="terminal-toolbar">
      <el-button :loading="terminal.busy.value" @click="terminal.create"
        >新建终端</el-button
      ><el-button @click="terminal.reload">刷新</el-button
      ><el-tag :type="terminal.connected.value ? 'success' : 'info'">{{
        terminal.connected.value ? '已连接' : '未连接'
      }}</el-tag>
    </div>
    <el-alert
      v-if="terminal.error.value"
      :title="terminal.error.value"
      type="error"
      :closable="false"
    />
    <div class="terminal-tabs">
      <div
        v-for="item in terminal.terminals.value"
        :key="item.id"
        class="terminal-tab"
        :class="{ active: terminal.selected.value === item.id }"
      >
        <el-button text @click="terminal.attach(item.id)"
          ><AppIcon name="terminal" />{{ item.name }} ·
          {{ item.status }}</el-button
        ><RowActions :busy="terminal.busy.value"
          ><el-button link @click="terminal.rename(item.id)">重命名</el-button>
          <el-button
            link
            @click="terminal.persistence(item.id, !item.persistence)"
            >{{ item.persistence ? '取消保持' : '保持终端' }}</el-button
          >
          <el-button link type="danger" @click="terminal.closeTerminal(item.id)"
            >关闭进程</el-button
          ></RowActions
        >
      </div>
    </div>
    <div ref="host" class="terminal-host" role="region" aria-label="设备终端" />
    <p>关闭面板不会结束终端；使用“关闭进程”显式释放实例。</p>
  </section>
</template>
