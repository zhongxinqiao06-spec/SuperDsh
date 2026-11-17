<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ExpandableText from '@/components/base/ExpandableText.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
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
const dirty = ref(false)
const candidates = computed(
  () =>
    state.value?.jobs.filter((job) =>
      kind.value === 'voice' ? job.kind === 'speech' : job.kind === 'image',
    ) ?? [],
)
const candidatePage = ref(1)
const candidatePageSize = ref(10)
const visibleCandidates = computed(() =>
  candidates.value.slice(
    (candidatePage.value - 1) * candidatePageSize.value,
    candidatePage.value * candidatePageSize.value,
  ),
)
watch([kind, candidatePageSize], () => {
  candidatePage.value = 1
})
watch(
  () => candidates.value.length,
  (count) => {
    candidatePage.value = Math.min(
      candidatePage.value,
      Math.max(1, Math.ceil(count / candidatePageSize.value)),
    )
  },
)
const adopted = (id: string) =>
  [state.value?.asset.sourceJob, state.value?.asset.voicePreviewJob].includes(
    id,
  )
watch(
  [
    kind,
    configuration,
    voice,
    text,
    prompt,
    useReference,
    allowDuplicate,
    reason,
  ],
  () => {
    dirty.value = true
  },
)
watch(kind, () => {
  configuration.value = ''
  voice.value = ''
})
</script>
<template>
  <ManagementDialog
    :model-value="true"
    title="个人素材制作"
    :busy="flow.busy.value || mutation.busy.value"
    :dirty="dirty"
    :error="flow.error.value || mutation.error.value"
    :submit-disabled="!state"
    submit-text="检查生成方案"
    @submit="prepare"
    @update:model-value="emit('close')"
  >
    <div class="stack">
      <p v-if="!state" role="status">
        {{
          mutation.error.value
            ? '素材加载失败，请关闭后重试。'
            : '正在读取素材与候选…'
        }}
      </p>
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
          >模型<el-select
            v-model="configuration"
            :empty-values="[null, undefined]"
            aria-label="个人素材模型"
            ><el-option value="" label="后台默认模型" /><el-option
              v-for="model in models"
              :key="model.id"
              :value="model.id"
              :label="model.name" /></el-select
        ></label>
        <template v-if="kind === 'voice'">
          <label class="field"
            >音色<el-select
              v-model="voice"
              :empty-values="[null, undefined]"
              aria-label="试听音色"
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
        <p v-if="!candidates.length">暂无候选，先选择模型并检查方案。</p>
        <article
          v-for="job in visibleCandidates"
          :key="job.id"
          class="panel studio-panel form-stack"
        >
          <div class="toolbar">
            <strong>{{
              job.kind === 'image' ? '参考图' : '配音 · ' + job.voice
            }}</strong
            ><span>{{ jobStates[job.state] ?? job.state }}</span>
          </div>
          <ExpandableText
            v-if="job.error"
            :text="job.error"
            label="失败详情"
            :lines="2"
          /><ExpandableText
            v-if="job.text"
            :text="job.text"
            label="台词"
            :lines="2"
          />
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
              :disabled="mutation.busy.value || adopted(job.id)"
              @click="adopt(job.id)"
              >{{
                adopted(job.id) ? '当前已采用' : '采用并保存新版本'
              }}</el-button
            ><StudioRecovery :project="null" :job="job" @recovered="refresh" />
          </div>
        </article>
        <ManagementPagination
          v-if="candidates.length"
          v-model:current-page="candidatePage"
          v-model:page-size="candidatePageSize"
          :total="candidates.length"
        />
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
