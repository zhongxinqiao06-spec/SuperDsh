<script setup lang="ts">
import { createUuid } from '@/utils/uuid'
import { computed, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/store/modules/auth-store'
import { useMutation } from '@/composables/use-mutation'
import { productionApi } from '@/api/studio/production-api'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import type { Job } from '@/types/studio/studio'
import type { JobDecision } from '@/types/studio/production'
/** 取消、原回执恢复与人工核对在项目、个人库和任务目录复用同一交互。 */
const props = defineProps<{
  project: string | null
  job: Pick<
    Job,
    'id' | 'revision' | 'kind' | 'state' | 'recoveryState' | 'hasReceipt'
  >
}>()
const emit = defineEmits<{ recovered: [Job] }>()
const open = ref(false),
  reason = ref(''),
  acknowledged = ref(false)
const history = ref<Awaited<ReturnType<typeof productionApi.history>>>([])
const mutation = useMutation(),
  auth = useAuthStore()
const permitted = computed(() =>
  auth.can(props.project ? 'studio.projects.write' : 'studio.assets.write'),
)
const active = computed(() =>
  ['queued', 'submitting', 'polling', 'downloading'].includes(props.job.state),
)
const check = computed(() =>
  ['unknown', 'paused', 'unaccepted'].includes(props.job.state),
)
const retry = computed(
  () =>
    props.job.state === 'failed' &&
    (props.job.kind === 'export' ||
      ['polling', 'downloading'].includes(props.job.recoveryState ?? '')),
)
const keys = new Map<string, string>()
async function decide(action: JobDecision) {
  const identity = JSON.stringify([
    action,
    reason.value,
    acknowledged.value,
    props.job.state,
  ])
  if (!keys.has(identity)) keys.set(identity, createUuid())
  await mutation.run(async () => {
    const result = await productionApi.decide(
      props.job,
      action,
      keys.get(identity)!,
      reason.value,
      acknowledged.value,
    )
    emit('recovered', result)
    if (open.value) history.value = await productionApi.history(props.job.id)
    if (
      ['queued', 'polling', 'downloading', 'cancelled'].includes(result.state)
    )
      open.value = false
  })
}
async function cancel() {
  const accepted = await ElMessageBox.confirm(
    props.job.state === 'queued'
      ? '此任务尚未提交，确认取消？'
      : '停止本地处理并尝试取消远端排队任务。已在生成的远端任务可能继续计费；保留回执供后续核对。',
    '取消任务',
    {
      confirmButtonText: '确认取消',
      cancelButtonText: '继续制作',
      type: 'warning',
    },
  )
    .then(() => true)
    .catch(() => false)
  if (accepted) await decide('cancel')
}
function inspect() {
  open.value = true
  void mutation.run(async () => {
    history.value = await productionApi.history(props.job.id)
  })
}
</script>
<template>
  <template v-if="permitted">
    <el-button
      v-if="active"
      link
      type="danger"
      :loading="mutation.busy.value"
      @click="cancel"
      >取消任务</el-button
    >
    <el-button
      v-if="retry"
      link
      :loading="mutation.busy.value"
      @click="decide('resume')"
      >恢复原任务</el-button
    >
    <el-button v-if="check" link @click="inspect">核对任务</el-button>
  </template>
  <small v-if="mutation.error.value && !open" role="alert">{{
    mutation.error.value
  }}</small>
  <ManagementDialog v-if="open" v-model="open" title="核对任务" readonly>
    <div class="stack">
      <p>修订 {{ job.revision }} · 任务 {{ job.id }}</p>
      <p>
        先查询本次提交的持久回执。没有回执时，按提交时间到供应商控制台核对并记录依据；系统不会自动重发。
      </p>
      <div class="toolbar">
        <el-button :loading="mutation.busy.value" @click="decide('receipt')"
          >核对原回执并恢复</el-button
        ><el-button
          v-if="job.hasReceipt"
          :disabled="mutation.busy.value"
          @click="decide('resume')"
          >恢复结果查询或下载</el-button
        >
      </div>
      <label class="field"
        >核对依据<el-input
          v-model="reason"
          type="textarea"
          aria-label="核对依据"
          maxlength="4000"
          placeholder="填写供应商控制台核对时间、记录和处理结论"
      /></label>
      <el-checkbox v-model="acknowledged"
        >我已在供应商侧确认本次请求未受理</el-checkbox
      >
      <div class="toolbar">
        <el-button
          :disabled="mutation.busy.value || !reason.trim()"
          @click="decide('keep')"
          >记录并继续待核对</el-button
        ><el-button
          :disabled="mutation.busy.value || !reason.trim() || !acknowledged"
          @click="decide('unaccepted')"
          >记录未受理结论</el-button
        >
      </div>
      <p v-if="job.state === 'unaccepted'">
        已保存人工结论。需要重新生成时，在自选制作中勾选对应内容，明确确认重复执行风险后再预检。
      </p>
      <p v-if="mutation.error.value" role="alert">{{ mutation.error.value }}</p>
      <div v-for="(entry, index) in history" :key="index" class="form-stack">
        <small>{{ entry.created }} · {{ entry.detail.remoteStatus }}</small>
        <p>{{ entry.detail.reason || '任务操作已记录' }}</p>
      </div>
    </div>
  </ManagementDialog>
</template>
