<script setup lang="ts">
import { ref } from 'vue'
import ScrollPanel from '@/components/layout/ScrollPanel.vue'
import type {
  QuickDraft,
  QuickInputMode,
  QuickModel,
} from '@/types/studio/quick'
import type { StudioAsset } from '@/types/studio/studio'
import { quickModeLabels } from '@/utils/studio/quick'
import StudioMedia from '../StudioMedia.vue'

/** 快速输入只呈现当前模型允许的能力；资料选择和任务提交由宿主用例负责。 */
const draft = defineModel<QuickDraft>({ required: true })
defineProps<{
  models: QuickModel[]
  model?: QuickModel
  references: StudioAsset[]
  disabled: boolean
  uploading: boolean
  canUpload: boolean
  canChoose: boolean
  canGenerate: boolean
  issue: string
  progress: number
  active: boolean
}>()
const emit = defineEmits<{
  mode: [QuickInputMode]
  model: [string]
  upload: [File[]]
  choose: []
  remove: [string]
  assist: []
  generate: []
}>()
const fileInput = ref<HTMLInputElement>()
function upload(event: Event) {
  const input = event.target as HTMLInputElement
  emit('upload', Array.from(input.files ?? []))
  input.value = ''
}
function mode(value: string | number) {
  if (value === 'text' || value === 'reference' || value === 'image')
    emit('mode', value)
}
</script>
<template>
  <ScrollPanel class="quick-panel" label="快速创作输入">
    <template #header>
      <el-tabs
        :model-value="draft.inputMode"
        aria-label="视频生成方式"
        class="quick-mode-tabs"
        @tab-change="mode"
      >
        <el-tab-pane
          v-for="(label, value) in quickModeLabels"
          :key="value"
          :name="value"
          :label="label"
          :disabled="disabled"
        />
      </el-tabs>
    </template>
    <div class="form-stack">
      <section
        v-if="draft.inputMode !== 'text' || references.length"
        class="form-stack"
        aria-label="参考素材"
      >
        <div class="toolbar">
          <strong>参考素材</strong
          ><small class="studio-meta"
            >{{ references.length }} /
            {{
              draft.inputMode === 'image' ? 1 : (model?.maxReferences ?? 0)
            }}</small
          >
        </div>
        <div v-if="references.length" class="quick-reference-grid">
          <article
            v-for="asset in references"
            :key="asset.id"
            class="quick-reference"
          >
            <div class="quick-reference-image">
              <StudioMedia
                :project="asset.project"
                :asset="asset.id"
                kind="image"
              />
            </div>
            <span :title="asset.name">{{ asset.name }}</span>
            <small>版本 {{ asset.version ?? 1 }}</small>
            <el-button
              text
              :disabled="disabled"
              :aria-label="'移除参考：' + asset.name"
              @click="emit('remove', asset.id)"
              >移除</el-button
            >
          </article>
        </div>
        <div class="toolbar">
          <input
            ref="fileInput"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            @change="upload"
          />
          <el-button
            v-if="canUpload"
            :disabled="disabled || !model?.maxReferences"
            :loading="uploading"
            @click="fileInput?.click()"
            >上传图片</el-button
          >
          <el-button
            v-if="canChoose"
            :disabled="disabled || !model?.maxReferences"
            @click="emit('choose')"
            >从素材库选</el-button
          >
        </div>
        <small v-if="uploading" role="status"
          >正在上传 {{ progress }}%，已成功的参考会保留。</small
        >
        <small class="studio-meta">{{
          draft.inputMode === 'image'
            ? '单张参考图用于保留形象，不等同于锁定视频首帧。'
            : '使用角色、场景、道具或图片的具体版本。'
        }}</small>
      </section>
      <label class="field"
        >提示词
        <el-input
          v-model="draft.prompt"
          type="textarea"
          :autosize="{ minRows: 6, maxRows: 12 }"
          maxlength="12000"
          show-word-limit
          :disabled="disabled"
          aria-label="视频提示词"
          placeholder="描述谁在什么地方、做什么动作，以及想要的画面风格。"
        />
      </label>
      <div class="toolbar">
        <el-button
          :disabled="disabled || !draft.prompt.trim() || !canGenerate"
          text
          @click="emit('assist')"
          >AI 润色</el-button
        ><small class="studio-meta">先对比建议，再选择采用。</small>
      </div>
      <section class="form-stack" aria-label="生成参数">
        <strong>生成参数</strong>
        <label class="field"
          >模型
          <el-select
            :model-value="
              models.some((item) => item.id === draft.configurationId)
                ? draft.configurationId
                : undefined
            "
            :disabled="disabled || !models.length"
            :placeholder="
              draft.configurationId
                ? '已保存模型当前不可用'
                : '暂无可用视频模型'
            "
            aria-label="视频模型"
            @update:model-value="emit('model', String($event))"
            ><el-option
              v-for="item in models"
              :key="item.id"
              :label="item.name"
              :value="item.id"
          /></el-select>
        </label>
        <div class="quick-parameter-grid">
          <label class="field"
            >时长<el-select
              v-model="draft.durationSeconds"
              :disabled="disabled || !model"
              aria-label="视频时长"
              ><el-option
                v-for="seconds in model?.durations ?? []"
                :key="seconds"
                :label="seconds + ' 秒'"
                :value="seconds" /></el-select
          ></label>
          <label class="field"
            >画幅<el-select
              v-model="draft.aspect"
              :disabled="disabled || !model"
              aria-label="视频画幅"
              ><el-option
                v-for="value in model?.aspects ?? []"
                :key="value"
                :label="value"
                :value="value" /></el-select
          ></label>
          <label class="field"
            >清晰度<el-select
              v-model="draft.resolution"
              :disabled="disabled || !model"
              aria-label="视频清晰度"
              ><el-option
                v-for="value in model?.resolutions ?? []"
                :key="value"
                :label="value"
                :value="value" /></el-select
          ></label>
          <div class="field">
            <span>数量</span><span class="quick-single-count">每次 1 条</span>
          </div>
        </div>
      </section>
      <slot name="options" />
    </div>
    <template #footer>
      <div class="form-stack">
        <small v-if="!canGenerate" class="studio-meta"
          >当前账号没有模型使用权限。</small
        >
        <small v-else-if="active" role="status"
          >这部作品正在生成，完成或取消后再提交。</small
        >
        <small v-else-if="issue" class="studio-meta">{{ issue }}</small>
        <small v-else class="studio-meta"
          >下一步核对模型、参考图和用量，确认后才开始生成。</small
        >
        <el-button
          type="primary"
          class="quick-generate"
          :disabled="disabled || !canGenerate || !!issue || active"
          @click="emit('generate')"
          >生成一条视频</el-button
        >
      </div>
    </template>
  </ScrollPanel>
</template>
