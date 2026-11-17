<script setup lang="ts">
import { createUuid } from '@/utils/uuid'
import { computed, ref } from 'vue'
import { preparationApi } from '@/api/studio/preparation-api'
import type {
  StudioProject,
  StudioCatalog,
  Shot,
  Job,
} from '@/types/studio/studio'
import { jobStates } from '@/utils/studio/media-labels'
import StudioMedia from '../StudioMedia.vue'
import PreparationGenerationDialog from './PreparationGenerationDialog.vue'

/** 每镜的静态画面候选先比较再采用，生成结果不会自行进入镜头引用。 */
const props = defineProps<{
  project: StudioProject
  shot: Shot
  catalog?: StudioCatalog
  readonly: boolean
  save: () => Promise<void>
}>()
const emit = defineEmits<{ updated: [] }>()
const generating = ref(false),
  busy = ref(false),
  error = ref('')
const jobs = computed(() =>
  props.project.jobs.filter(
    (j) => j.purpose === 'storyboard' && j.subject === props.shot.id,
  ),
)
const adopted = computed(() =>
  props.project.assets
    .filter((a) => props.shot.references.includes(a.id))
    .map((a) => a.sourceJob),
)
let attempt: { signature: string; key: string } | undefined
async function adopt(job: Job) {
  if (busy.value || props.readonly) return
  busy.value = true
  error.value = ''
  try {
    await props.save()
    const data = {
      revision: props.project.revision,
      job: job.id,
      target: props.shot.id,
    }
    const signature = JSON.stringify(data)
    if (attempt?.signature !== signature)
      attempt = { signature, key: createUuid() }
    await preparationApi.adopt(props.project.id, {
      ...data,
      requestKey: attempt.key,
    })
    attempt = undefined
    emit('updated')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="panel preparation-candidate">
    <div class="toolbar">
      <div>
        <h2>本镜参考画面</h2>
        <p class="studio-meta">
          先看构图与人物设定，采用后用于分镜预演和后续制作。
        </p>
      </div>
      <span class="toolbar-spacer" /><el-button
        v-if="!readonly"
        :disabled="busy"
        @click="generating = true"
        >生成分镜图</el-button
      >
    </div>
    <p v-if="!jobs.length" class="studio-meta">
      还没有分镜图候选，也可以在镜头编辑里引用已上传的图片。
    </p>
    <div class="preparation-candidate-grid">
      <article v-for="job in jobs" :key="job.id">
        <StudioMedia
          v-if="job.state === 'ready'"
          :project="project.id"
          :job="job.id"
          kind="image"
        /><span>{{ jobStates[job.state] ?? job.state }}</span>
        <p v-if="job.error" role="alert">{{ job.error }}</p>
        <el-button
          v-if="job.state === 'ready' && !readonly"
          :disabled="busy || adopted.includes(job.id)"
          @click="adopt(job)"
          >{{
            adopted.includes(job.id) ? '已采用画面' : '采用为分镜图'
          }}</el-button
        >
      </article>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <PreparationGenerationDialog
      v-if="generating"
      :project="project"
      :catalog="catalog"
      :target="shot.id"
      kind="storyboard"
      title="生成本镜分镜图"
      :save="save"
      @close="generating = false"
      @submitted="
        () => {
          generating = false
          emit('updated')
        }
      "
    />
  </section>
</template>
