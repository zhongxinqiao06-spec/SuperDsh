<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { InputInstance } from 'element-plus'
import AppIcon from '@/components/base/AppIcon.vue'
import type { StudioDocument } from '@/types/studio/studio'
import type { DirectorAction } from '@/types/studio/director'
import { useScriptScenes } from '@/composables/studio/use-script-scenes'
import { sceneSummary } from '@/utils/studio/script-workspace'
import '@/assets/styles/studio-script.css'
import type { TextEditTarget } from '@/types/studio/text-edit'
import { replaceScript, updateScript } from '@/utils/studio/script-text'

/** 剧本工作区按写作、场次编排和导演建议组织，不把所有场次同时展开成表单。 */
const model = defineModel<StudioDocument>({ required: true })
const props = defineProps<{
  disabled: boolean
  brief?: string
  canDirect?: boolean
  hasProposal?: boolean
}>()
const emit = defineEmits<{
  direct: [DirectorAction]
  review: []
  shot: [string]
  assist: [TextEditTarget?]
}>()
const { scenes, selected, active, summary, add, move, remove } =
  useScriptScenes(model, () => props.disabled)
const reading = ref(false),
  selection = ref('')
const selectionRange = ref({ start: 0, end: 0 })
const scriptText = computed({
  get: () => model.value.script,
  set: (value) => updateScript(model.value, value),
})
const sceneText = computed({
  get: () =>
    active.value?.scriptRange
      ? Array.from(model.value.script)
          .slice(active.value.scriptRange.start, active.value.scriptRange.end)
          .join('')
      : '',
  set: (value) => {
    const range = active.value?.scriptRange
    if (range) replaceScript(model.value, range.start, range.end, value)
  },
})
function assist(scene = false) {
  const range = scene ? active.value?.scriptRange : selectionRange.value
  if (!range || range.end <= range.start) return
  emit('assist', {
    ...range,
    scope: scene ? 'scene' : 'selection',
    sceneId: scene ? active.value?.id : undefined,
    label: scene ? (active.value?.title ?? '当前场次') : '选中正文',
    script: model.value.script,
    text: Array.from(model.value.script).slice(range.start, range.end).join(''),
  })
}
function linkScene() {
  if (active.value && selection.value)
    active.value.scriptRange = { ...selectionRange.value }
}
const scriptInput = ref<InputInstance>(),
  sceneInput = ref<InputInstance>()
const hasScript = computed(() => !!model.value.script.trim())
const characters = computed(() => model.value.script.replace(/\s/gu, '').length)
const selectedIndex = computed(() =>
  scenes.value.findIndex((scene) => scene.id === selected.value),
)
watch(
  () => model.value.script,
  () => {
    selection.value = ''
  },
)
function selectText(event: Event) {
  const input = event.target as HTMLTextAreaElement
  selection.value = input.value.slice(input.selectionStart, input.selectionEnd)
  selectionRange.value = {
    start: Array.from(input.value.slice(0, input.selectionStart)).length,
    end: Array.from(input.value.slice(0, input.selectionEnd)).length,
  }
}
async function createScene(fromSelection = false) {
  add(fromSelection ? selection.value : '')
  if (fromSelection) linkScene()
  selection.value = ''
  await nextTick()
  sceneInput.value?.focus()
}
async function focusScript() {
  reading.value = false
  await nextTick()
  scriptInput.value?.focus()
  scriptInput.value?.$el.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
defineExpose({ focusScript })
</script>
<template>
  <section class="script-workspace" aria-label="剧本编排工作区">
    <div v-if="!hasScript || hasProposal" class="script-intro">
      <div>
        <h2>{{ hasScript ? '剧本与场次' : '先把故事讲清楚' }}</h2>
        <p>
          写下故事或粘贴剧本，整理场次，再审阅导演建议。下一步为角色定造型与声音。
        </p>
      </div>
      <el-button v-if="hasProposal" type="primary" plain @click="emit('review')"
        >审阅导演方案</el-button
      >
    </div>
    <div v-if="!hasScript && brief?.trim()" class="script-brief">
      <AppIcon name="book-open" :size="20" />
      <div>
        <strong>从你的故事构想开始</strong>
        <p>{{ brief }}</p>
      </div>
      <el-button
        v-if="!disabled"
        :disabled="!canDirect || hasProposal"
        @click="emit('direct', 'draft')"
        >让导演起草</el-button
      >
    </div>
    <div class="script-desk">
      <section class="panel script-manuscript" aria-label="故事原稿">
        <div class="script-panel-heading">
          <h3>故事原稿</h3>
          <div class="toolbar">
            <el-button text type="primary" @click="emit('assist')"
              ><AppIcon name="sparkles" />AI 修改记录</el-button
            >
            <span class="studio-meta">{{ characters }} 字</span>
            <el-button
              v-if="hasScript"
              text
              type="primary"
              :aria-pressed="reading"
              @click="reading = !reading"
              ><AppIcon name="book-open" />{{
                reading ? '继续编辑' : '阅读剧本'
              }}</el-button
            >
          </div>
        </div>
        <p v-if="!hasScript" class="studio-meta">
          不必先写专业格式。说清楚谁在哪里、发生了什么，以及关键对白。
        </p>
        <div
          v-if="reading"
          class="script-reading"
          tabindex="0"
          aria-label="剧本阅读稿"
        >
          {{ model.script }}
        </div>
        <el-input
          v-else
          ref="scriptInput"
          v-model="scriptText"
          type="textarea"
          :autosize="{ minRows: 10, maxRows: 18 }"
          :disabled="disabled"
          maxlength="100000"
          aria-label="剧本正文"
          placeholder="粘贴已有剧本，或从一个故事开始……&#10;&#10;人物：谁是主角，他想做什么？&#10;发生：在哪里，遇到了什么？&#10;转折：什么改变了局面？&#10;结尾：最后留下什么画面？"
          @select="selectText"
        />
        <div
          v-if="selection && !disabled"
          class="script-selection"
          role="status"
        >
          <span>已选 {{ Array.from(selection).length }} 字</span>
          <el-button
            type="primary"
            text
            :disabled="!canDirect || Array.from(selection).length > 12000"
            @click="assist()"
            ><AppIcon name="sparkles" />AI 修改选段</el-button
          >
          <el-button
            v-if="active"
            :disabled="Array.from(selection).length > 12000"
            @click="linkScene"
            >关联到当前场次</el-button
          >
          <el-button
            :disabled="selection.length > 12000"
            @click="createScene(true)"
            >选中文字建一场</el-button
          >
          <small v-if="selection.length > 12000"
            >每场最多 12000 字，请缩小选择范围。</small
          >
        </div>
        <div class="script-direction form-stack">
          <div class="toolbar">
            <span>导演如何处理原文</span>
            <el-radio-group
              v-model="model.adaptationMode"
              :disabled="disabled"
              aria-label="拆解方式"
            >
              <el-radio-button value="original">忠于原文</el-radio-button>
              <el-radio-button value="adapt">允许改编</el-radio-button>
            </el-radio-group>
          </div>
          <p class="studio-meta">
            {{
              model.adaptationMode === 'adapt'
                ? '导演可建议调整情节和对白，改动由你审阅后采用。'
                : '保留原文与对白，导演只整理场次、角色和镜头。'
            }}
          </p>
          <div class="toolbar">
            <el-button
              v-if="!disabled"
              type="primary"
              :disabled="!hasScript || !canDirect || hasProposal"
              @click="emit('direct', 'decompose')"
              ><AppIcon name="sparkles" />整理场次与分镜</el-button
            >
            <span class="studio-meta">{{
              hasProposal
                ? '已有一份导演建议，请先审阅，再发起新整理。'
                : '先审阅方案，不会自动生成视频或配音。'
            }}</span>
          </div>
          <p v-if="!disabled && !canDirect" class="studio-meta">
            当前账号没有导演会话权限，仍可手工编排场次。
          </p>
        </div>
      </section>
      <section class="panel script-scenes" aria-label="场次编排">
        <div class="script-panel-heading">
          <h3>
            场次安排 <small>{{ scenes.length }}</small>
          </h3>
          <el-button v-if="!disabled" text type="primary" @click="createScene()"
            ><AppIcon name="plus" />添加场次</el-button
          >
        </div>
        <p class="studio-meta">
          地点、时间或情节转折发生变化时，可以另起一场。
        </p>
        <div v-if="!scenes.length" class="script-scene-empty">
          <AppIcon name="file-text" :size="28" />
          <strong>故事先写，场次随后整理</strong>
          <p>
            让导演从剧本整理，或选中一段原文创建一场。这里会成为你的故事目录。
          </p>
        </div>
        <template v-else>
          <nav class="script-scene-list" aria-label="场次目录">
            <button
              v-for="(scene, index) in scenes"
              :key="scene.id"
              type="button"
              :aria-current="selected === scene.id ? 'true' : undefined"
              @click="selected = scene.id"
            >
              <span class="script-scene-number">{{
                String(index + 1).padStart(2, '0')
              }}</span>
              <span
                ><strong>{{ scene.title || '未命名场次' }}</strong
                ><small>{{
                  scene.synopsis || '写下这一场发生的事'
                }}</small></span
              >
              <small>{{ sceneSummary(model, scene.id).shots.length }} 镜</small>
            </button>
          </nav>
          <div v-if="active" class="script-scene-detail form-stack">
            <div class="toolbar">
              <span class="eyebrow"
                >正在编排 · 第 {{ selectedIndex + 1 }} 场</span
              ><span class="toolbar-spacer" /><el-button
                text
                :disabled="disabled || selectedIndex === 0"
                @click="move(-1)"
                >上移</el-button
              ><el-button
                text
                :disabled="disabled || selectedIndex === scenes.length - 1"
                @click="move(1)"
                >下移</el-button
              >
            </div>
            <label class="field"
              >场次名称<el-input
                ref="sceneInput"
                v-model="active.title"
                maxlength="240"
                aria-label="场次名称"
                :disabled="disabled"
                placeholder="例如：站台 · 傍晚重逢"
            /></label>
            <label class="field"
              >这一场发生什么<el-input
                v-model="active.synopsis"
                type="textarea"
                :autosize="{ minRows: 4, maxRows: 12 }"
                maxlength="12000"
                aria-label="场次摘要"
                :disabled="disabled"
                placeholder="谁在这里，做了什么？保留关键动作和对白。"
            /></label>
            <template v-if="active.scriptRange">
              <label class="field"
                >本场正文 · 与全文同步<el-input
                  v-model="sceneText"
                  aria-label="本场正文"
                  type="textarea"
                  :autosize="{ minRows: 5, maxRows: 14 }"
                  :disabled="disabled"
              /></label>
              <el-button
                :disabled="
                  disabled || !canDirect || Array.from(sceneText).length > 12000
                "
                @click="assist(true)"
                >AI 修改本场</el-button
              >
            </template>
            <p v-else class="studio-meta">
              先在剧本中选中本场正文，点击“关联到当前场次”，即可手工或 AI
              修改本场。摘要不作为完整正文。
            </p>
            <div v-if="summary.shots.length" class="form-stack">
              <span class="studio-meta"
                >{{ summary.shots.length }} 个镜头 · {{ summary.lines }} 句对白
                · {{ summary.duration }} 秒</span
              >
              <el-button
                v-for="shot in summary.shots"
                :key="shot.id"
                text
                class="script-shot-link"
                @click="emit('shot', shot.id)"
                >查看镜头：{{ shot.action || '待补动作'
                }}<AppIcon name="arrow-right"
              /></el-button>
            </div>
            <div class="toolbar">
              <span class="studio-meta">{{
                summary.shots.length
                  ? '场次已有镜头，调整顺序不会改变镜头内容。'
                  : '镜头将在分镜设计中继续细化。'
              }}</span
              ><el-button
                v-if="!disabled"
                text
                type="danger"
                :disabled="!!summary.shots.length"
                @click="remove"
                >移除空场次</el-button
              >
            </div>
          </div>
        </template>
      </section>
    </div>
  </section>
</template>
