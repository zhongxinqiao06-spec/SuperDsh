<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ScrollPanel from '@/components/layout/ScrollPanel.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ExpandableText from '@/components/base/ExpandableText.vue'
import type { QuickJob } from '@/types/studio/quick'
import { jobStates } from '@/utils/studio/media-labels'
import StudioMedia from '../StudioMedia.vue'
import StudioRecovery from '../StudioRecovery.vue'

/** 点击候选只切换预览；收藏和进入分镜由宿主确认后执行。 */
const selectedId = defineModel<string>({ required: true })
const props = defineProps<{
  project: string
  jobs: QuickJob[]
  selected?: QuickJob
  busy: boolean
  canEdit: boolean
  canCollect: boolean
  collected: boolean
}>()
const emit = defineEmits<{
  refresh: []
  download: []
  collect: []
  promote: []
  reuse: []
}>()
const page = ref(1),
  pageSize = ref(6)
const visible = computed(() =>
  props.jobs.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
)
watch(selectedId, (id) => {
  const index = props.jobs.findIndex((job) => job.id === id)
  if (index >= 0) page.value = Math.floor(index / pageSize.value) + 1
})
const ready = computed(() => props.selected?.state === 'ready')
</script>
<template>
  <ScrollPanel class="quick-panel quick-results" label="快速视频生成结果">
    <template #header
      ><div class="toolbar quick-results-heading">
        <h2>生成结果</h2>
        <span class="studio-meta">{{ jobs.length }} 个候选</span
        ><el-button :disabled="busy || !project" text @click="emit('refresh')"
          >刷新</el-button
        >
      </div></template
    >
    <div class="form-stack">
      <template v-if="selected">
        <div v-if="ready" class="quick-player">
          <StudioMedia
            :key="selected.id"
            :project="project"
            :job="selected.id"
            kind="video"
            controls
          />
        </div>
        <div v-else class="quick-result-state" role="status">
          <strong>{{ jobStates[selected.state] ?? '正在核对任务状态' }}</strong>
          <p
            v-if="
              ['queued', 'submitting', 'polling', 'downloading'].includes(
                selected.state,
              )
            "
          >
            视频正在处理，离开页面后仍会继续。你可以先准备下一条的内容。
          </p>
          <p
            v-else-if="
              ['unknown', 'paused', 'unaccepted'].includes(selected.state)
            "
          >
            这次提交需要核对受理情况，请先处理原回执，再决定是否另行生成。
          </p>
          <p v-else-if="selected.state === 'cancelled'">
            任务已取消，提示词和已有候选均已保留。
          </p>
          <p v-else>生成未完成，当前输入和其他结果仍然保留。</p>
          <StudioRecovery
            :project="project"
            :job="selected"
            label="快速视频"
            @recovered="emit('refresh')"
          />
        </div>
        <ExpandableText
          v-if="selected.error"
          :text="selected.error"
          label="失败详情"
          :lines="3"
        />
        <div v-if="selected.quickDraft" class="toolbar quick-result-meta">
          <span
            >{{ selected.quickDraft.durationSeconds }} 秒 ·
            {{ selected.quickDraft.aspect }} ·
            {{ selected.quickDraft.resolution }}</span
          >
          <el-button text :disabled="busy || !canEdit" @click="emit('reuse')"
            >复用这次参数</el-button
          >
        </div>
      </template>
      <div v-else class="quick-result-state">
        <strong>把想法变成第一条视频</strong>
        <p>
          写下画面内容，选择参考与参数。确认生成后，进度和每次结果都会保存在这里。
        </p>
      </div>
      <div
        v-if="jobs.length"
        class="quick-candidates"
        role="group"
        aria-label="视频候选"
      >
        <button
          v-for="job in visible"
          :key="job.id"
          class="quick-candidate"
          :aria-pressed="selectedId === job.id"
          :disabled="busy"
          @click="selectedId = job.id"
        >
          <span class="quick-candidate-picture"
            ><StudioMedia
              v-if="job.state === 'ready'"
              :project="project"
              :job="job.id"
              kind="video"
              lazy
            /><span v-else>{{ jobStates[job.state] ?? '处理中' }}</span></span
          >
          <strong
            >候选
            {{
              job.candidateNumber ??
              jobs.length - jobs.findIndex((item) => item.id === job.id)
            }}</strong
          >
          <span>{{ jobStates[job.state] ?? '处理中' }}</span>
        </button>
      </div>
      <ManagementPagination
        v-if="jobs.length > pageSize"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="jobs.length"
        :page-sizes="[6, 12, 24]"
      />
    </div>
    <template #footer>
      <div v-if="ready" class="toolbar quick-result-actions">
        <el-button :disabled="busy" @click="emit('download')"
          >下载视频</el-button
        >
        <el-button
          v-if="canCollect"
          :disabled="busy || collected"
          @click="emit('collect')"
          >{{ collected ? '已收藏' : '收藏到素材库' }}</el-button
        >
        <el-button
          v-if="canEdit"
          type="primary"
          :disabled="busy"
          @click="emit('promote')"
          >继续到分镜创作</el-button
        >
      </div>
      <small v-else class="studio-meta"
        >候选分别保留，完成后可以比较、下载或继续编辑。</small
      >
    </template>
  </ScrollPanel>
</template>
