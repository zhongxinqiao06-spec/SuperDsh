<script setup lang="ts">
import { watch } from 'vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { usePersonalProduction } from '@/composables/studio/use-personal-production'
import { jobStates } from '@/utils/studio/media-labels'
import ProductionPlanDialog from './ProductionPlanDialog.vue'
import StudioMedia from './StudioMedia.vue'
import StudioRecovery from './StudioRecovery.vue'
const props = defineProps<{ entity: string }>()
const emit = defineEmits<{ close: []; updated: [] }>()
const {
  allowDuplicate,
  reason,
  state,
  mutation,
  flow,
  kind,
  configuration,
  voice,
  text,
  prompt,
  useReference,
  models,
  voices,
  prepare,
  adopt,
  refresh,
} = usePersonalProduction(props.entity, () => emit('updated'))
watch(kind, () => {
  configuration.value = ''
  voice.value = ''
})
</script>
<template>
  <ManagementDialog
    :model-value="true"
    title="个人素材制作"
    readonly
    @update:model-value="emit('close')"
  >
    <div class="stack">
      <p v-if="mutation.error.value" role="alert">{{ mutation.error.value }}</p>
      <template v-if="state">
        <h3>
          {{ state.asset.name }} · 当前版本
          {{ state.asset.version ?? state.revision }}
        </h3>
        <p class="studio-meta">
          直接制作个人素材，确认采用后保存新版本。已引用它的作品仍保留原版本。
        </p>
        <el-radio-group v-model="kind" aria-label="个人素材制作类型"
          ><el-radio-button value="reference">生成参考图</el-radio-button
          ><el-radio-button
            v-if="state.asset.kind === 'character'"
            value="voice"
            >试听与声音</el-radio-button
          ></el-radio-group
        >
        <label class="field"
          >模型<el-select v-model="configuration" aria-label="个人素材模型"
            ><el-option value="" label="后台默认模型" /><el-option
              v-for="model in models"
              :key="model.id"
              :value="model.id"
              :label="model.name" /></el-select
        ></label>
        <template v-if="kind === 'voice'">
          <label class="field"
            >音色<el-select v-model="voice" aria-label="试听音色"
              ><el-option
                v-for="item in voices"
                :key="item"
                :value="item"
                :label="item" /></el-select
          ></label>
          <label class="field"
            >试听台词<el-input
              v-model="text"
              type="textarea"
              maxlength="500"
              aria-label="试听台词"
          /></label>
        </template>
        <template v-else
          ><label class="field"
            >补充画面要求<el-input
              v-model="prompt"
              type="textarea"
              maxlength="4000"
              aria-label="补充画面要求" /></label
          ><el-checkbox v-if="state.asset.fileId" v-model="useReference"
            >沿用当前参考图</el-checkbox
          ></template
        >
        <div class="toolbar">
          <el-button type="primary" :loading="flow.busy.value" @click="prepare"
            >检查生成方案</el-button
          ><span v-if="flow.error.value" role="alert">{{
            flow.error.value
          }}</span>
        </div>
        <template
          v-if="
            state.jobs.some((j) =>
              ['unknown', 'paused', 'unaccepted'].includes(j.state),
            )
          "
          ><el-checkbox v-model="allowDuplicate"
            >已核对仍要重新生成，接受可能重复计费</el-checkbox
          ><label v-if="allowDuplicate" class="field"
            >重新生成原因<el-input
              v-model="reason"
              type="textarea"
              aria-label="个人素材重新生成原因" /></label
        ></template>
        <h3>生成候选</h3>
        <p v-if="!state.jobs.length">暂无候选，先选择模型并检查方案。</p>
        <article
          v-for="job in state.jobs"
          :key="job.id"
          class="panel studio-panel form-stack"
        >
          <div class="toolbar">
            <strong>{{
              job.kind === 'image' ? '参考图' : '配音 · ' + job.voice
            }}</strong
            ><span>{{ jobStates[job.state] ?? job.state }}</span>
          </div>
          <p v-if="job.error">{{ job.error }}</p>
          <p v-if="job.text">{{ job.text }}</p>
          <StudioMedia
            v-if="job.state === 'ready'"
            :project="null"
            :job="job.id"
            :kind="job.kind === 'image' ? 'image' : 'audio'"
            controls
          />
          <div class="toolbar">
            <el-button
              v-if="job.state === 'ready'"
              :disabled="mutation.busy.value"
              @click="adopt(job.id)"
              >采用并保存新版本</el-button
            ><StudioRecovery :project="null" :job="job" @recovered="refresh" />
          </div>
        </article>
      </template>
    </div>
    <ProductionPlanDialog
      v-if="flow.plan.value"
      v-model="flow.open.value"
      :plan="flow.plan.value"
      :busy="flow.busy.value"
      :error="flow.error.value"
      @confirm="flow.confirm"
    />
  </ManagementDialog>
</template>
