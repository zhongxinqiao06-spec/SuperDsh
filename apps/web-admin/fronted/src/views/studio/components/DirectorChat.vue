<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import AppDrawer from '@/components/overlay/AppDrawer.vue'
import { useAuthStore } from '@/store/modules/auth-store'
import InteractionCard from '@/views/workbench/components/InteractionCard.vue'
import ReasoningDetails from '@/views/workbench/components/ReasoningDetails.vue'
import { messageReasoning, messageText } from '@/utils/workbench/timeline'
import type { StudioDocument } from '@/types/studio/studio'
import type { DirectorAction } from '@/types/studio/director'
import { directorInstruction } from '@/utils/studio/script-workspace'
import { useDirectorChat } from '@/composables/studio/use-director-chat'
import { useDirectorSources } from '@/composables/studio/use-director-sources'
import DirectorSources from './DirectorSources.vue'

/** 任务入口带入已保存的故事与改编边界；补充要求始终保留，打开抽屉不会自动发送。 */
const props = defineProps<{
  project: string
  active: boolean
  existing: string | null
  agents: { id: string; name: string }[]
  save: () => Promise<void>
  reload: () => Promise<void>
  revision: number
  context?: string
  action?: DirectorAction
  brief?: string
  document: StudioDocument
  hasProposal: boolean
}>()
const auth = useAuthStore()
const emit = defineEmits<{
  draft: [boolean]
  review: []
  'update:active': [boolean]
}>()
const formId = `director-request-${useId()}`
const canRun = computed(
  () => auth.can('sessions.read') && auth.can('sessions.run'),
)
const draft = ref('')
const idea = ref(props.brief ?? '')
const sentIdea = ref(props.brief ?? '')
const submitError = ref('')
const submitBusy = ref(false)
let lastGuided = false
const canUpload = computed(
  () =>
    auth.can('files.write') &&
    auth.can('files.read') &&
    auth.can('studio.assets.write'),
)
const canReadAssets = computed(() => auth.can('studio.assets.read'))
const sources = useDirectorSources({
  project: props.project,
  active: () => props.active,
  revision: () => props.revision,
  save: props.save,
  reload: props.reload,
  canReadAssets: () => canReadAssets.value,
  canUpload: () => canUpload.value,
})
const {
  session,
  agent,
  busy,
  running,
  error,
  progress,
  snapshot,
  send,
  respond,
  bindingOutdated,
  refreshBinding,
  interrupt,
} = useDirectorChat({
  project: props.project,
  existing: () => props.existing,
  active: () => props.active,
  allowed: () => canRun.value,
  save: props.save,
})
watch(
  () => props.brief,
  (value, previous) => {
    if (!idea.value || idea.value === previous) idea.value = value ?? ''
    if (!sentIdea.value || sentIdea.value === previous)
      sentIdea.value = value ?? ''
  },
)
watch(
  [draft, idea, sentIdea, sources.hasSources],
  ([text, story, sent, references]) =>
    emit('draft', !!text.trim() || story !== sent || references),
)
const locked = computed(
  () =>
    busy.value ||
    submitBusy.value ||
    sources.uploading.value ||
    sources.preparing.value,
)
const blocked = computed(() =>
  props.action === 'draft'
    ? !idea.value.trim() && !sources.references.value
    : !props.document.script.trim(),
)
const title = computed(() =>
  props.action === 'draft' ? '根据构想起草故事' : '整理场次与分镜',
)
async function submit(guided = false) {
  if (
    locked.value ||
    running.value ||
    (guided && (blocked.value || props.hasProposal))
  )
    return
  lastGuided = guided
  submitBusy.value = true
  submitError.value = ''
  try {
    const sourceContext = await sources.prepare(idea.value || draft.value)
    const instructions = guided
      ? directorInstruction({
          action: props.action ?? 'decompose',
          brief:
            idea.value.trim() ||
            '根据我选择的参考形象提出一个简洁、有起承转合的短片故事；不确定的设定作为建议呈现。',
          script: props.document.script,
          mode: props.document.adaptationMode ?? 'original',
        })
      : ''
    const text = [instructions, draft.value.trim(), sourceContext?.text]
      .filter(Boolean)
      .join('\n补充要求：')
    if (!text) return
    const before = draft.value
    const sent = await send(
      props.context ? `[当前作品工作区：${props.context}]\n${text}` : text,
      undefined,
      sourceContext?.attachments ?? [],
    )
    if (sent) {
      if (draft.value === before) draft.value = ''
      sentIdea.value = idea.value
      sources.submitted()
    }
  } catch (cause) {
    submitError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    submitBusy.value = false
  }
}
async function recoverAndRetry() {
  if (locked.value || running.value) return
  if (await refreshBinding()) await submit(lastGuided)
}
async function stop() {
  if (locked.value || !running.value) return
  submitBusy.value = true
  try {
    await interrupt()
  } catch (cause) {
    submitError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    submitBusy.value = false
  }
}
</script>
<template>
  <AppDrawer
    :model-value="active"
    title="作品导演助手"
    @update:model-value="emit('update:active', $event)"
  >
    <section class="studio-director">
      <div v-if="action" class="director-task form-stack">
        <h2>{{ title }}</h2>
        <p class="studio-meta">
          {{
            action === 'draft'
              ? '一句想法或一个参考形象，就可以开始。'
              : '从当前剧本整理场次、角色和镜头。'
          }}
          方案由你审阅采用，这一步不生成视频或配音。
        </p>
      </div>
      <div v-if="hasProposal" class="director-result form-stack" role="status">
        <strong>导演方案已到，等待你的决定</strong>
        <p>比较原稿与建议，只采用你认可的内容。</p>
      </div>
      <p v-if="!canRun" class="studio-meta">创作对话需要会话读取和运行权限。</p>
      <form
        v-else
        :id="formId"
        class="stack"
        @submit.prevent="submit(!!action)"
      >
        <label v-if="action === 'draft'" class="field">
          你的故事想法
          <el-input
            v-model="idea"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 6 }"
            maxlength="6000"
            :disabled="locked"
            placeholder="比如：噜噜和朋友去海南旅游，有椰林和海边日落。也可以先选一个形象，让 AI 帮你想故事。"
          />
        </label>
        <DirectorSources
          :sources="sources"
          :disabled="locked || running"
          :can-upload="canUpload"
          :can-read-assets="canReadAssets"
          :can-preview="auth.can('files.read')"
        />
        <label class="field">
          {{ action ? '补充要求（可选）' : '给导演的指令' }}
          <el-input
            v-model="draft"
            type="textarea"
            :disabled="locked"
            maxlength="6000"
            :autosize="{ minRows: 3, maxRows: 8 }"
            :placeholder="
              action
                ? '例如：轻松可爱、四个镜头，保留结尾悬念。'
                : '第三镜换成雨夜，保留角色造型和原台词'
            "
          />
        </label>
        <details v-if="!session" class="director-settings">
          <summary>导演设置（可选）</summary>
          <div class="form-stack">
            <label class="field">
              导演智能体
              <select v-model="agent" class="native-control" :disabled="locked">
                <option value="">作品分镜导演</option>
                <option v-for="a in agents" :key="a.id" :value="a.id">
                  {{ a.name }}
                </option>
              </select>
            </label>
            <p class="studio-meta">
              {{
                document.adaptationMode === 'adapt'
                  ? '允许提出改编建议，由你决定采用。'
                  : '已有原文和对白保留。'
              }}
            </p>
          </div>
        </details>
        <p v-if="action && blocked" class="studio-meta">
          {{
            action === 'draft'
              ? '写一句想法，或者选择参考形象，就可以让 AI 帮你起草。'
              : '请先补充剧本正文，再让导演整理。'
          }}
        </p>
      </form>
      <details
        v-if="
          snapshot?.timeline.items.some(
            (item) => messageText(item) || messageReasoning(item),
          )
        "
        class="director-history"
      >
        <summary>创作对话记录</summary>
        <div class="director-thread" aria-label="创作对话记录">
          <template v-for="item in snapshot.timeline.items" :key="item.id">
            <ReasoningDetails
              v-if="messageReasoning(item)"
              :text="messageReasoning(item)"
            />
            <p
              v-if="messageText(item)"
              class="director-message"
              :class="{ 'director-prompt': item.role === 'user' }"
            >
              <strong>{{ item.role === 'user' ? '你' : '导演' }}</strong
              >{{ messageText(item) }}
            </p>
          </template>
        </div>
      </details>
      <InteractionCard
        v-for="notice in [
          ...(snapshot?.notices ?? []),
          ...(snapshot?.approvals ?? []),
        ].filter((n) =>
          ['open', 'responding'].includes(String(n.status ?? 'open')),
        )"
        :key="notice.id"
        :notice="notice"
        :session-id="session"
        :disabled="!canRun || busy || notice.status === 'responding'"
        @respond="respond"
      />
    </section>
    <template v-if="canRun" #footer>
      <el-alert
        v-if="submitError || error"
        :title="submitError || error"
        type="error"
        :closable="false"
        show-icon
      />
      <p v-if="bindingOutdated" class="studio-meta">
        本次想法和参考资料已保留，更新导演工具后可继续。
      </p>
      <p
        v-else-if="locked || running || progress"
        class="studio-meta"
        role="status"
      >
        {{
          sources.preparing.value
            ? sources.progress.value
            : busy
              ? progress
              : running
                ? '导演正在处理，完成后即可审阅。关闭面板不影响任务。'
                : progress
        }}
      </p>
      <div class="dialog-actions">
        <el-button v-if="running" :disabled="locked" @click="stop"
          >停止本次处理</el-button
        >
        <el-button
          v-if="!action && !hasProposal"
          :disabled="locked || running || !document.script.trim()"
          @click="submit(true)"
          >根据剧本拆分镜头</el-button
        >
        <el-button v-if="hasProposal" type="primary" @click="emit('review')"
          >去审阅方案</el-button
        >
        <el-button
          v-else-if="bindingOutdated"
          type="primary"
          :disabled="locked || running"
          @click="recoverAndRetry"
          >更新预置助手工具并重试</el-button
        >
        <el-button
          v-else
          type="primary"
          native-type="submit"
          :form="formId"
          :loading="locked"
          :disabled="
            running ||
            (action ? blocked : !draft.trim() && !sources.hasSources.value)
          "
          >{{ action ? '开始' + title : '发送' }}</el-button
        >
      </div>
    </template>
  </AppDrawer>
</template>
<style scoped>
.studio-director {
  display: grid;
  align-content: start;
  min-width: 0;
  gap: var(--layout-gap);
}
.director-task {
  gap: var(--label-gap);
}
.director-task h2 {
  font-size: var(--font-size-section);
  line-height: var(--line-height-section);
}
.director-task p,
.director-result p {
  margin: 0;
  overflow-wrap: anywhere;
}
.director-result {
  padding: var(--field-gap);
  gap: var(--label-gap);
  background: var(--accent);
  border-radius: var(--radius);
}
.director-thread {
  display: grid;
  gap: var(--field-gap);
}
.director-message {
  display: grid;
  justify-self: start;
  max-width: 94%;
  gap: var(--space-1);
  padding: var(--control-gap) var(--space-3);
  border-radius: var(--radius);
  margin: 0;
  background: var(--muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.director-message strong {
  font-size: var(--font-size-meta);
  color: var(--muted-foreground);
}
.director-prompt {
  justify-self: end;
  background: var(--accent);
}
.director-settings,
.director-history {
  padding-top: var(--field-gap);
  border-top: 1px solid var(--border);
}
.director-settings > div,
.director-history > div {
  padding-top: var(--field-gap);
}
</style>
