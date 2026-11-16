<script setup lang="ts">
import { computed } from 'vue'
import type { StudioProject } from '@/types/studio/studio'
import type { StageState } from '@/types/studio/preparation'
import { useScriptConfirmation } from '@/composables/studio/use-script-confirmation'

/** 先展示本次确认的实际故事与场次，再将服务端阶段确认作为继续创作的明确动作。 */
const props = defineProps<{
  project: StudioProject
  state?: StageState
  readonly: boolean
  pending: boolean
  save: () => Promise<void>
}>()
const emit = defineEmits<{ confirmed: []; write: []; proposal: [] }>()
const { open, busy, error, changed, review, confirm } = useScriptConfirmation({
  project: () => props.project,
  readonly: () => props.readonly,
  save: props.save,
  confirmed: () => emit('confirmed'),
})
const hasScript = computed(() => !!props.project.document.script.trim())
const completed = computed(
  () => props.state?.status === 'confirmed' && !props.pending,
)
const characters = computed(
  () => props.project.document.script.replace(/\s/gu, '').length,
)
</script>
<template>
  <section class="panel script-next" aria-label="剧本确认与下一步">
    <div class="toolbar">
      <div class="form-stack">
        <strong>{{
          completed
            ? '剧本已确认，可以继续设定角色'
            : hasScript
              ? '故事准备好了，再进入角色设定'
              : '先写下故事，再确认剧本'
        }}</strong>
        <p class="studio-meta">
          {{
            project.proposal
              ? '导演提交了一份建议，请先比较并决定采用哪些内容。'
              : hasScript
                ? '下一步：选择角色造型、场景参考和声音。场次与分镜仍可继续调整。'
                : '可以粘贴已有剧本，也可以从上方的故事构想请导演起草。'
          }}
        </p>
      </div>
      <span class="toolbar-spacer" />
      <el-button
        v-if="project.proposal"
        type="primary"
        @click="emit('proposal')"
        >查看待审方案</el-button
      >
      <el-button v-else-if="!hasScript && !readonly" @click="emit('write')"
        >去写故事</el-button
      >
      <el-button
        v-else-if="!readonly"
        type="primary"
        :disabled="!state"
        @click="completed ? emit('confirmed') : review()"
        >{{ completed ? '进入角色与场景' : '审阅剧本并继续' }}</el-button
      >
    </div>
    <p v-if="state?.status === 'stale'" class="studio-meta">
      你调整了剧本或场次，重新确认后继续；已生成素材仍保留。
    </p>
    <p v-if="!state && hasScript" class="studio-meta">
      阶段检查尚未就绪，原稿可以继续编辑和保存。
    </p>
  </section>
  <el-dialog
    v-model="open"
    title="确认本次剧本"
    width="min(680px, 94vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <div class="form-stack">
      <p>
        确认故事内容后，下一步为人物定造型、选声音。本次确认不会提交媒体生成。
      </p>
      <div class="script-confirm-summary">
        <span>{{ characters }} 字原稿</span
        ><span>{{ project.document.scenes?.length ?? 0 }} 场</span
        ><span>{{ project.document.shots.length }} 个分镜</span
        ><span>{{
          project.document.adaptationMode === 'adapt'
            ? '允许导演建议改编'
            : '保留原文与对白'
        }}</span>
      </div>
      <div class="script-confirm-copy" tabindex="0" aria-label="本次确认的剧本">
        {{ project.document.script }}
      </div>
      <ol v-if="project.document.scenes?.length">
        <li v-for="scene in project.document.scenes" :key="scene.id">
          {{ scene.title
          }}{{ scene.synopsis ? ' — ' + scene.synopsis : '（场次内容待细化）' }}
        </li>
      </ol>
      <p v-else class="studio-meta">还未划分场次，可以在分镜设计时继续整理。</p>
      <el-alert
        v-if="changed"
        title="审阅期间内容已更新，请返回重新核对。"
        type="warning"
        :closable="false"
      />
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
    </div>
    <template #footer
      ><div class="dialog-actions">
        <el-button :disabled="busy" @click="open = false">返回修改</el-button
        ><el-button
          type="primary"
          :loading="busy"
          :disabled="readonly || changed || !hasScript || !!project.proposal"
          @click="confirm"
          >确认剧本，进入人物设定</el-button
        >
      </div></template
    >
  </el-dialog>
</template>
