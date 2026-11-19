<script setup lang="ts">
import { watch } from 'vue'
import AppDrawer from '@/components/overlay/AppDrawer.vue'
import AiTextComparison from '@/components/form/AiTextComparison.vue'
import InteractionCard from '@/views/workbench/components/InteractionCard.vue'
import { useTextEdit } from '@/composables/studio/use-text-edit'
import type { StudioProject } from '@/types/studio/studio'
import type { TextEditTarget } from '@/types/studio/text-edit'

/** AI 编辑面板不直接保存正文；选择范围、建议审阅和撤回走同一服务。 */
const props = defineProps<{
  project: StudioProject
  target?: TextEditTarget
  active: boolean
  allowed: boolean
  save: () => Promise<void>
  reload: () => Promise<void>
  title?: string
}>()
const emit = defineEmits<{ busy: [boolean]; draft: [boolean]; close: [] }>()
const {
  records,
  selected,
  instruction,
  suggestion,
  busy,
  error,
  notice,
  hasDraft,
  current,
  chat,
  generate,
  resolve,
} = useTextEdit({
  project: () => props.project,
  target: () => props.target,
  active: () => props.active,
  allowed: () => props.allowed,
  save: props.save,
  reload: props.reload,
})
watch(busy, (value) => emit('busy', value))
watch(hasDraft, (value) => emit('draft', value))
const states = {
  waiting: '等待建议',
  ready: '待采用',
  applied: '已采用',
  discarded: '已放弃',
  undone: '已撤回',
}
</script>
<template>
  <AppDrawer
    :model-value="active"
    :title="title ?? 'AI 剧本编辑'"
    size="min(680px, 100vw)"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    @update:model-value="emit('close')"
  >
    <section class="form-stack">
      <template v-if="target && !current">
        <strong
          >{{ target.scope === 'scene' ? '修改本场' : '修改选段' }} ·
          {{ target.label }}</strong
        >
        <p class="studio-meta">
          只修改选定的
          {{ Array.from(target.text).length }} 字，采用前正文保持不变。
        </p>
        <details>
          <summary>查看选中正文</summary>
          <p class="selected-text">{{ target.text }}</p>
        </details>
        <div class="toolbar" aria-label="快捷修改要求">
          <el-button
            v-for="prompt in [
              '润色表达，保留原意',
              '精简内容，保留关键情节',
              '对白更自然，保留人物和结尾',
            ]"
            :key="prompt"
            :disabled="busy"
            @click="instruction = prompt"
            >{{ prompt.split('，')[0] }}</el-button
          >
        </div>
        <label class="field"
          >希望怎么修改<el-input
            v-model="instruction"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 6 }"
            maxlength="2000"
            :disabled="busy"
            placeholder="例如：对白更轻松，保留最后一句。"
        /></label>
        <p class="studio-meta">
          发送即授权 AI 改写本次范围，不改变整篇的“忠于原文”设置。
        </p>
      </template>
      <template v-if="current">
        <div class="toolbar">
          <strong>{{ current.label }}</strong
          ><el-tag>{{ states[current.state] }}</el-tag>
        </div>
        <p>{{ current.instruction }}</p>
        <AiTextComparison
          v-if="current.suggestion !== null"
          v-model="suggestion"
          :original="current.original"
          :disabled="busy || current.state !== 'ready' || !allowed"
          :conflict="current.conflict"
        />
        <p v-else class="studio-meta" role="status">
          {{
            chat.running.value
              ? 'AI 正在生成建议，可以关闭面板继续编辑。'
              : '尚未收到完整建议。可以检查导演进度，或放弃后重新生成。'
          }}
        </p>
        <el-alert
          v-if="current.state === 'applied' && current.conflict"
          :title="current.conflict"
          type="warning"
          :closable="false"
        />
      </template>
      <InteractionCard
        v-for="item in [
          ...(chat.snapshot.value?.notices ?? []),
          ...(chat.snapshot.value?.approvals ?? []),
        ].filter((n) =>
          ['open', 'responding'].includes(String(n.status ?? 'open')),
        )"
        :key="item.id"
        :notice="item"
        :session-id="chat.session.value"
        :disabled="!allowed || busy"
        @respond="chat.respond"
      />
      <p v-if="chat.progress.value" class="studio-meta" role="status">
        {{ chat.progress.value }}
      </p>
      <el-alert
        v-if="error || chat.error.value"
        :title="error || chat.error.value"
        type="error"
        :closable="false"
      />
      <el-alert
        v-if="notice"
        :title="notice"
        type="success"
        :closable="false"
      />
      <div class="form-stack" aria-label="AI 修改记录">
        <strong>最近修改</strong>
        <p v-if="!records.length" class="studio-meta">
          选中正文或打开已关联的场次，即可开始修改。
        </p>
        <button
          v-for="item in records"
          :key="item.id"
          class="text-edit-record"
          :disabled="busy"
          :aria-pressed="selected === item.id"
          @click="selected = item.id"
        >
          <span>{{ item.label }} · {{ item.instruction }}</span
          ><small>{{ states[item.state] }}</small>
        </button>
      </div>
    </section>
    <template #footer
      ><div v-if="target && !current" class="dialog-actions">
        <el-button
          type="primary"
          :loading="busy"
          :disabled="!allowed || !instruction.trim() || chat.running.value"
          @click="generate"
          >生成修改建议</el-button
        >
      </div>
      <template v-if="current">
        <div class="toolbar">
          <el-button
            v-if="current.state === 'ready'"
            type="primary"
            :disabled="
              !allowed || busy || !!current.conflict || !suggestion.trim()
            "
            @click="resolve('apply')"
            >采用并保存</el-button
          >
          <el-button
            v-if="current.state === 'applied'"
            :disabled="!allowed || busy || !!current.conflict"
            @click="resolve('undo')"
            >撤回本次采用</el-button
          >
          <el-button
            v-if="['waiting', 'ready'].includes(current.state)"
            :disabled="!allowed || busy"
            @click="resolve('discard')"
            >放弃本次建议</el-button
          >
          <el-button
            v-if="target"
            :disabled="busy || chat.running.value"
            @click="selected = ''"
            >返回修改要求</el-button
          >
        </div>
      </template></template
    >
  </AppDrawer>
</template>
<style scoped>
.selected-text {
  white-space: pre-wrap;

  overflow-wrap: anywhere;
}
.text-edit-record {
  display: flex;
  gap: var(--control-gap);
  text-align: start;
  justify-content: space-between;
  padding: var(--field-gap);
  background: var(--muted);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--foreground);
}
.text-edit-record span {
  overflow-wrap: anywhere;
  min-width: 0;
}
.text-edit-record small {
  flex-shrink: 0;
  color: var(--muted-foreground);
}
</style>
