<script setup lang="ts">
import { computed, onScopeDispose } from 'vue'
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/store/modules/auth-store'
import PageHeader from '@/components/layout/PageHeader.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useQuickProject } from '@/composables/studio/use-quick-project'
import { useQuickReferences } from '@/composables/studio/use-quick-references'
import ProductionPlanDialog from './components/ProductionPlanDialog.vue'
import StudioTextEditor from './components/project/StudioTextEditor.vue'
import StudioAssetPicker from './components/library/StudioAssetPicker.vue'
import QuickInputPanel from './components/quick/QuickInputPanel.vue'
import QuickResultPanel from './components/quick/QuickResultPanel.vue'
import '@/assets/styles/studio-quick.css'

/** 快速页面装配公共资料、AI 对比和媒体恢复组件，不新增执行循环。 */
const route = useRoute(),
  router = useRouter(),
  auth = useAuthStore()
const initialId = String(route.params.project ?? route.params.id ?? '')
const vm = useQuickProject(initialId && initialId !== 'new' ? initialId : null)
const disabled = computed(
  () =>
    !vm.canEdit.value || vm.busy.value || vm.loading.value || vm.stale.value,
)
const references = useQuickReferences({
  selected: () => vm.draft.value.references,
  limit: () =>
    vm.draft.value.inputMode === 'image'
      ? 1
      : (vm.model.value?.maxReferences ?? 0),
  editable: () => !disabled.value,
  add: (asset) => {
    vm.rememberAssets([asset])
    vm.draft.value.references.push(asset.id)
  },
})
const blocked = computed(() => disabled.value || references.mutation.busy.value)
const uncertain = computed(() =>
  vm.jobs.value.some((job) =>
    ['unknown', 'paused', 'unaccepted'].includes(job.state),
  ),
)
const hasReady = computed(() =>
  vm.jobs.value.some((job) => job.state === 'ready'),
)
async function syncUrl() {
  if (!vm.id.value || vm.aiDirty.value || vm.aiOpen.value) return
  const path = '/entertainment/quick/' + encodeURIComponent(vm.id.value)
  if (route.path !== path) await router.replace(path)
}
async function save() {
  if (await vm.save()) await syncUrl()
}
async function confirm() {
  if (await vm.confirm()) await syncUrl()
}
async function closePlan(value: boolean) {
  vm.planOpen.value = value
  if (!value && !vm.busy.value) await syncUrl()
}
function removeReference(id: string) {
  if (!blocked.value)
    vm.draft.value.references = vm.draft.value.references.filter(
      (item) => item !== id,
    )
}
async function reload() {
  if (vm.dirty.value || vm.aiDirty.value) {
    const accepted = await ElMessageBox.confirm(
      '重新载入会替换本页未保存输入和 AI 面板未采用的手工修改。已保存候选与任务不受影响。',
      '核对最新草稿',
      {
        confirmButtonText: '载入最新草稿',
        cancelButtonText: '继续编辑',
        type: 'warning',
      },
    )
      .then(() => true)
      .catch(() => false)
    if (!accepted) return
  }
  await vm.mutation.run(async () => {
    await vm.refresh(true)
    vm.aiOpen.value = false
    vm.aiProject.value = undefined
    vm.aiDirty.value = false
  })
}
async function promote() {
  const accepted = await ElMessageBox.confirm(
    '将以当前选中的视频候选建立一镜工程，继续添加分镜、配音和剪辑。已有候选与生成记录保留。',
    '继续到分镜创作',
    { confirmButtonText: '进入分镜创作', cancelButtonText: '继续比较' },
  )
    .then(() => true)
    .catch(() => false)
  if (accepted && (await vm.promote()))
    await router.push('/entertainment/' + encodeURIComponent(vm.id.value))
}
async function leave() {
  if (!auth.can('studio.projects.write')) return true
  if (vm.busy.value || references.mutation.busy.value) return false
  if (!vm.dirty.value && !vm.aiDirty.value) return true
  try {
    await ElMessageBox.confirm(
      vm.aiDirty.value
        ? '视频提示词与参数可以保存。AI 面板尚未采用的手工修改会放弃，已生成的建议仍保留在记录中。'
        : '当前提示词或参数尚未保存，要先保存再离开吗？',
      '未保存的修改',
      {
        confirmButtonText: '保存草稿并离开',
        cancelButtonText: '放弃修改',
        distinguishCancelAndClose: true,
        closeOnClickModal: false,
        type: 'warning',
      },
    )
  } catch (action) {
    return action === 'cancel'
  }
  return await vm.save()
}
onBeforeRouteLeave(leave)
onBeforeRouteUpdate(leave)
function beforeUnload(event: BeforeUnloadEvent) {
  if (vm.dirty.value || vm.aiDirty.value || references.mutation.busy.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
window.addEventListener('beforeunload', beforeUnload)
onScopeDispose(() => window.removeEventListener('beforeunload', beforeUnload))
</script>
<template>
  <section class="page management-page">
    <PageHeader title="快速创作" />
    <div class="toolbar">
      <el-input
        v-model="vm.title.value"
        class="quick-title-input"
        maxlength="120"
        aria-label="快速作品名称"
        placeholder="作品名称"
        :disabled="blocked"
      />
      <el-button
        v-if="vm.canEdit.value"
        :loading="vm.mutation.busy.value"
        :disabled="blocked || !vm.title.value.trim()"
        @click="save"
        >保存草稿</el-button
      >
      <router-link v-if="!vm.id.value" to="/entertainment"
        >返回创作中心</router-link
      >
      <router-link v-else to="/entertainment/works">返回我的作品</router-link>
      <span class="studio-meta quick-status-line" role="status">{{
        vm.dirty.value ? '有未保存的修改' : vm.notice.value
      }}</span>
    </div>
    <ResourceStatus
      :loading="vm.loading.value"
      :error="vm.loadError.value"
      :has-data="Boolean(vm.state.value || vm.capabilities.value.models.length)"
      @retry="vm.load"
    />
    <el-alert
      v-if="vm.mutation.error.value || references.mutation.error.value"
      :title="vm.mutation.error.value || references.mutation.error.value"
      type="error"
      :closable="false"
    />
    <el-alert
      v-if="vm.pollError.value"
      :title="vm.pollError.value"
      type="warning"
      :closable="false"
    />
    <el-alert
      v-if="vm.stale.value"
      title="草稿已在其他页面更新，当前输入仍保留。请核对最新版本后继续。"
      type="warning"
      :closable="false"
      ><el-button text @click="reload">载入最新草稿</el-button></el-alert
    >
    <el-alert
      v-if="vm.state.value?.creationMode === 'storyboard'"
      title="这部作品已进入分镜创作，原候选仍可查看。"
      type="info"
      :closable="false"
      ><router-link :to="'/entertainment/' + vm.id.value"
        >继续分镜创作</router-link
      ></el-alert
    >
    <el-alert
      v-else-if="vm.state.value?.lifecycle === 'archived'"
      title="作品已归档，请在作品目录恢复后继续编辑。"
      type="info"
      :closable="false"
    />
    <div
      v-if="!vm.loading.value && !vm.loadError.value"
      class="quick-workspace"
    >
      <QuickInputPanel
        v-model="vm.draft.value"
        :models="vm.models.value"
        :model="vm.model.value"
        :references="vm.references.value"
        :disabled="blocked"
        :uploading="references.mutation.busy.value"
        :can-upload="references.canUpload.value"
        :can-choose="references.canChoose.value"
        :can-generate="auth.can('models.use')"
        :progress="references.progress.value"
        :issue="vm.issue.value"
        :active="vm.active.value"
        @mode="vm.setMode"
        @model="vm.setModel"
        @upload="references.upload"
        @choose="references.pickerOpen.value = true"
        @remove="removeReference"
        @assist="vm.openAi"
        @generate="vm.prepare"
      >
        <template #options>
          <section
            v-if="hasReady || uncertain"
            class="form-stack quick-duplicate-options"
          >
            <el-checkbox
              v-if="hasReady"
              v-model="vm.regenerate.value"
              :disabled="blocked"
              >同参数已有结果时，另生成一个候选供比较</el-checkbox
            >
            <details v-if="uncertain">
              <summary>已核对受理情况，需要另行提交</summary>
              <div class="form-stack">
                <p class="studio-meta">
                  优先在右侧核对原任务。另行提交可能重复计费，需要明确记录处理依据。
                </p>
                <el-checkbox
                  v-model="vm.allowDuplicate.value"
                  :disabled="blocked"
                  >我已核对原任务，仍要另行生成</el-checkbox
                ><label v-if="vm.allowDuplicate.value" class="field"
                  >核对依据与原因<el-input
                    v-model="vm.duplicateReason.value"
                    type="textarea"
                    :autosize="{ minRows: 2, maxRows: 5 }"
                    maxlength="12000"
                    :disabled="blocked"
                    aria-label="另行生成原因"
                /></label>
              </div>
            </details>
          </section>
        </template>
      </QuickInputPanel>
      <QuickResultPanel
        v-model="vm.selectedId.value"
        :project="vm.id.value"
        :jobs="vm.jobs.value"
        :selected="vm.selected.value"
        :busy="vm.busy.value || references.mutation.busy.value"
        :can-edit="vm.canEdit.value && !vm.stale.value"
        :can-collect="auth.can('studio.assets.write')"
        :collected="vm.collected.value.includes(vm.selectedId.value)"
        @refresh="vm.mutation.run(() => vm.refresh())"
        @download="vm.download"
        @collect="vm.collect"
        @promote="promote"
        @reuse="vm.reuse"
      />
    </div>
    <StudioAssetPicker
      v-if="references.pickerOpen.value"
      title="选择视频参考素材"
      :kinds="['character', 'scene', 'prop', 'image']"
      :resolve="references.resolve"
      :exclude-ids="vm.draft.value.references"
      personal-first
      @close="references.pickerOpen.value = false"
      @selected="references.add"
    />
    <ProductionPlanDialog
      v-if="vm.plan.value"
      :model-value="vm.planOpen.value"
      :plan="vm.plan.value"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="closePlan"
      @confirm="confirm"
    />
    <StudioTextEditor
      v-if="vm.aiProject.value"
      title="AI 提示词润色"
      :project="vm.aiProject.value"
      :target="vm.aiTarget.value"
      :active="vm.aiOpen.value"
      :allowed="vm.canEdit.value && auth.can('models.use')"
      :save="vm.saveForAi"
      :reload="vm.reloadForAi"
      @busy="vm.aiBusy.value = $event"
      @draft="vm.aiDirty.value = $event"
      @close="vm.aiOpen.value = false"
    />
  </section>
</template>
