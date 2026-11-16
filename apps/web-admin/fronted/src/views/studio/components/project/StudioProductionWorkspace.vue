<script setup lang="ts">
import { computed, ref } from 'vue'
import type { StudioProject, StudioCatalog } from '@/types/studio/studio'
import type { ProductionIntent } from '@/types/studio/production'
import { productionApi } from '@/api/studio/production-api'
import { useProductionPlan } from '@/composables/studio/use-production-plan'
import ProductionPlanDialog from '../ProductionPlanDialog.vue'
/** 批量入口先选范围再逐项预检，保存和网络错误保留当前工程。 */
const props = defineProps<{
  project: StudioProject
  catalog?: StudioCatalog
  disabled: boolean
  save: (label?: string) => Promise<unknown>
}>()
const emit = defineEmits<{ updated: [] }>()
const mode = ref<ProductionIntent['mode']>('missing'),
  shots = ref<string[]>([]),
  lines = ref<string[]>([])
const video = ref(''),
  referenceVideo = ref(''),
  speech = ref(''),
  allowDuplicate = ref(false),
  reason = ref('')
const models = computed(() => props.catalog?.configurations ?? [])
const flow = useProductionPlan(
  'projects',
  () => props.project.id,
  () => emit('updated'),
)
async function prepare() {
  await flow.prepare(async () => {
    await props.save('制作前保存工程')
    return productionApi.prepare(props.project.id, {
      revision: props.project.revision,
      requestKey: crypto.randomUUID(),
      mode: mode.value,
      shots: shots.value,
      lines: lines.value,
      video: video.value || undefined,
      referenceVideo: referenceVideo.value || undefined,
      speech: speech.value || undefined,
      allowDuplicate: allowDuplicate.value,
      reason: reason.value,
    })
  })
}
</script>
<template>
  <section class="panel studio-panel stack" aria-label="批量制作范围">
    <div class="toolbar">
      <h2>选择制作范围</h2>
      <el-tag>先检查，再提交</el-tag>
    </div>
    <el-radio-group v-model="mode" aria-label="制作范围">
      <el-radio-button value="missing">只补缺失</el-radio-button
      ><el-radio-button value="failed">只重做失败项</el-radio-button
      ><el-radio-button value="selected">自选镜头与台词</el-radio-button
      ><el-radio-button value="all">全部重新生成</el-radio-button>
    </el-radio-group>
    <p class="studio-meta">
      缺失包含未制作和输入已变更的内容。已有候选、执行中、受理待核对和可恢复的任务不会自动重发；原采用画面与配音保留。
    </p>
    <div v-if="mode === 'selected'" class="form-stack">
      <article
        v-for="(shot, index) in project.document.shots"
        :key="shot.id"
        class="panel studio-panel form-stack"
      >
        <el-checkbox-group v-model="shots"
          ><el-checkbox :value="shot.id"
            >镜 {{ index + 1 }} · {{ shot.action }}</el-checkbox
          ></el-checkbox-group
        >
        <el-checkbox-group v-model="lines" class="form-stack"
          ><el-checkbox
            v-for="line in shot.lines"
            :key="line.id"
            :value="line.id"
            >配音 · {{ line.text }}</el-checkbox
          ></el-checkbox-group
        >
      </article>
    </div>
    <div class="studio-grid">
      <label class="field"
        >文生视频模型<el-select
          v-model="video"
          :empty-values="[null, undefined]"
          aria-label="批量文生视频模型"
          ><el-option value="" label="使用后台默认模型" /><el-option
            v-for="m in models.filter(
              (m) =>
                m.capability === 'video.generate' &&
                m.parameters.inputMode !== 'reference',
            )"
            :key="m.id"
            :label="m.name"
            :value="m.id" /></el-select
      ></label>
      <label class="field"
        >参考图视频模型<el-select
          v-model="referenceVideo"
          :empty-values="[null, undefined]"
          aria-label="批量参考图模型"
          ><el-option
            value=""
            label="使用后台默认或匹配参考图的模型" /><el-option
            v-for="m in models.filter(
              (m) =>
                m.capability === 'video.generate' &&
                m.parameters.inputMode === 'reference',
            )"
            :key="m.id"
            :label="m.name"
            :value="m.id" /></el-select
      ></label>
      <label class="field"
        >配音模型<el-select
          v-model="speech"
          :empty-values="[null, undefined]"
          aria-label="批量配音模型"
          ><el-option value="" label="沿用角色音色绑定或后台默认" /><el-option
            v-for="m in models.filter(
              (m) => m.capability === 'speech.synthesize',
            )"
            :key="m.id"
            :label="m.name"
            :value="m.id" /></el-select
      ></label>
    </div>
    <template v-if="['all', 'selected'].includes(mode)">
      <el-checkbox v-model="allowDuplicate"
        >已核对待确认任务，仍要重新生成，接受可能重复计费</el-checkbox
      >
      <label v-if="allowDuplicate" class="field"
        >核对依据与重新生成原因<el-input
          v-model="reason"
          type="textarea"
          aria-label="重新生成原因"
          maxlength="4000"
      /></label>
    </template>
    <p v-if="flow.error.value" role="alert">{{ flow.error.value }}</p>
    <div class="toolbar">
      <el-button
        type="primary"
        :loading="flow.busy.value"
        :disabled="disabled || !project.document.shots.length"
        @click="prepare"
        >检查本次制作</el-button
      ><span v-if="!project.document.shots.length">请先完成分镜设计。</span>
    </div>
    <ProductionPlanDialog
      v-if="flow.plan.value"
      v-model="flow.open.value"
      :plan="flow.plan.value"
      :busy="flow.busy.value"
      :error="flow.error.value"
      @confirm="flow.confirm"
    />
  </section>
</template>
