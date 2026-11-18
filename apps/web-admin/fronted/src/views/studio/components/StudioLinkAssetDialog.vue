<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue'
import { sessionController } from '@/store/session-controller'
import { studioApi } from '@/api/studio/studio-api'
import { libraryApi } from '@/api/studio/library-api'
import { createUuid } from '@/utils/uuid'
import { applyAssetUse, type AssetUseTarget } from '@/utils/studio/asset-use'
import { prepareAssetUse } from '@/composables/studio/prepare-asset-use'
import { useMutation } from '@/composables/use-mutation'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import type { StudioAsset, StudioProject } from '@/types/studio/studio'
const props = defineProps<{ asset: StudioAsset }>()
const emit = defineEmits<{ close: []; linked: [title: string] }>()
const { data, query, filter, page, pageSize, loading, error, reload } =
  useStudioDirectory(studioApi.projectPage)
const mutation = useMutation()
const selected = ref<{ id: string; title: string }>()
const targetProject = ref<StudioProject>(),
  purpose = ref('library'),
  targetId = ref(''),
  loadingProject = ref(false),
  done = ref(false)
let attempt:
  { signature: string; importKey: string; saveKey: string } | undefined
let openController: AbortController | undefined
onScopeDispose(() => openController?.abort())
const targetOptions = computed(() =>
  purpose.value === 'scene'
    ? (targetProject.value?.document.scenes ?? []).map((scene) => ({
        id: scene.id,
        label: scene.title,
      }))
    : purpose.value === 'audio'
      ? (targetProject.value?.document.shots ?? []).flatMap((shot, index) =>
          shot.lines.map((line) => ({
            id: shot.id + '/' + line.id,
            label: `镜 ${index + 1} · ${line.text || '未填写台词'}`,
          })),
        )
      : (targetProject.value?.document.shots ?? []).map((shot, index) => ({
          id: shot.id,
          label: `镜 ${index + 1} · ${shot.scene || shot.action.slice(0, 24) || '未命名镜头'}`,
        })),
)
async function chooseProject(value: { id: string; title: string }) {
  if (mutation.busy.value) return
  openController?.abort()
  const controller = new AbortController(),
    generation = sessionController.generation
  openController = controller
  selected.value = value
  targetProject.value = undefined
  targetId.value = ''
  loadingProject.value = true
  mutation.error.value = ''
  try {
    const next = await studioApi.open(value.id, controller.signal)
    if (
      !controller.signal.aborted &&
      generation === sessionController.generation
    )
      targetProject.value = next
  } catch (cause) {
    if (
      !controller.signal.aborted &&
      generation === sessionController.generation
    )
      mutation.error.value =
        cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (openController === controller) loadingProject.value = false
  }
}
async function link() {
  if (done.value) {
    emit('linked', selected.value!.title)
    return
  }
  const project = selected.value
  if (!project || !targetProject.value) return
  if (
    await mutation.run(async () => {
      let target: AssetUseTarget = { kind: 'library' }
      if (purpose.value === 'music') target = { kind: 'music' }
      else if (purpose.value === 'scene')
        target = { kind: 'scene', sceneId: targetId.value }
      else if (purpose.value === 'audio') {
        const [shotId, lineId] = targetId.value.split('/')
        target = { kind: 'audio', shotId: shotId!, lineId: lineId! }
      } else if (purpose.value === 'video' || purpose.value === 'reference')
        target = { kind: purpose.value, shotId: targetId.value }
      const prepared = await prepareAssetUse(
        props.asset,
        target,
        targetProject.value!.document,
      )
      target = prepared.target
      const signature = JSON.stringify([
        project.id,
        props.asset.id,
        targetProject.value!.revision,
        target,
      ])
      if (attempt?.signature !== signature)
        attempt = { signature, importKey: createUuid(), saveKey: createUuid() }
      const result = await libraryApi.import(project.id, {
        sourceVersionId: props.asset.id,
        requestKey: attempt.importKey,
        expectedRevision: targetProject.value!.revision,
      })
      const asset = result.assets.find((item) => item.id === result.assetId)
      if (!asset) throw new Error('素材已引用，请刷新作品查看')
      if (target.kind !== 'library') {
        applyAssetUse(result.document, asset, target)
        await studioApi.save(
          project.id,
          result.revision,
          result.document,
          '选用素材库素材',
          attempt.saveKey,
        )
      }
    })
  )
    done.value = true
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    title="用于作品"
    :submit-text="done ? '完成' : '确认使用此版本'"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :submit-disabled="
      !done &&
      (!targetProject ||
        loadingProject ||
        (!['library', 'music'].includes(purpose) && !targetId))
    "
    @submit="link"
    @update:model-value="emit('close')"
  >
    <strong>{{ asset.name }}</strong>
    <template v-if="done"
      ><el-alert
        type="success"
        :closable="false"
        :title="'已加入作品「' + selected?.title + '」'"
      /><router-link
        :to="{
          path: '/entertainment/' + selected?.id,
          query: {
            section:
              purpose === 'music' || purpose === 'audio' || purpose === 'video'
                ? 'edit'
                : purpose === 'scene'
                  ? 'script'
                  : purpose === 'reference'
                    ? 'storyboard'
                    : 'cast',
            shot: ['audio', 'video', 'reference'].includes(purpose)
              ? targetId.split('/')[0]
              : undefined,
          },
        }"
        >进入作品继续创作 →</router-link
      ></template
    >
    <template v-else>
      <div class="toolbar">
        <el-input
          v-model="query"
          maxlength="120"
          placeholder="搜索作品名称"
          aria-label="搜索可引用作品"
          @keydown.enter.prevent="filter"
        /><el-button @click="filter">搜索</el-button>
      </div>
      <ResourceStatus
        :loading="loading"
        :error="error"
        :empty="!data?.total"
        empty-title="没有可选作品"
        empty-description="请先在作品项目中创建作品，或调整搜索条件。"
        @retry="reload"
      />
      <div
        v-if="data?.total"
        role="radiogroup"
        aria-label="选择作品"
        class="stack"
      >
        <label v-for="project in data.items" :key="project.id"
          ><input
            type="radio"
            name="target-project"
            :checked="selected?.id === project.id"
            @change="chooseProject(project)"
          />
          {{ project.title }}</label
        >
      </div>
      <ManagementPagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="data?.total ?? 0"
        :loading="loading"
      />
      <label v-if="targetProject" class="field"
        >使用方式<el-select
          v-model="purpose"
          aria-label="使用方式"
          @change="targetId = ''"
          ><el-option label="先加入本片素材" value="library" /><el-option
            v-if="asset.kind === 'scene'"
            label="用于一个场次"
            value="scene" /><el-option
            v-if="['character', 'scene', 'prop', 'image'].includes(asset.kind)"
            label="作为镜头参考"
            value="reference" /><el-option
            v-if="asset.kind === 'video'"
            label="作为镜头采用画面"
            value="video" /><el-option
            v-if="['audio', 'music'].includes(asset.kind)"
            label="作为台词配音"
            value="audio" /><el-option
            v-if="['audio', 'music'].includes(asset.kind)"
            label="作为背景音乐"
            value="music" /></el-select
      ></label>
      <label
        v-if="targetProject && !['library', 'music'].includes(purpose)"
        class="field"
        >选择使用位置<el-select
          v-model="targetId"
          aria-label="选择使用位置"
          filterable
          ><el-option
            v-for="target in targetOptions"
            :key="target.id"
            :value="target.id"
            :label="target.label" /></el-select
      ></label>
      <p
        v-if="
          targetProject &&
          !['library', 'music'].includes(purpose) &&
          !targetOptions.length
        "
        class="studio-meta"
      >
        作品还没有可用位置，请先加入本片素材，再到作品中安排。
      </p>
      <p
        v-if="purpose === 'video' || purpose === 'audio' || purpose === 'music'"
        class="studio-meta"
      >
        确认后替换该位置的当前采用素材，原结果仍保留。进入剪辑后检查时长、裁剪和音量。
      </p>
    </template>
  </ManagementDialog>
</template>
