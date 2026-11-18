<script setup lang="ts">
import { computed, ref } from 'vue'
import { libraryApi } from '@/api/studio/library-api'
import { useResource } from '@/composables/use-resource'
import { useAuthStore } from '@/store/modules/auth-store'
import { mediaKind } from '@/utils/studio/media-labels'
import type { StudioAsset } from '@/types/studio/studio'
import AppDrawer from '@/components/overlay/AppDrawer.vue'
import ExpandableText from '@/components/base/ExpandableText.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import StudioMedia from '../StudioMedia.vue'
import StudioAssetUsage from '../StudioAssetUsage.vue'
import { ElMessageBox } from 'element-plus'
import { useMutation } from '@/composables/use-mutation'
import { createUuid } from '@/utils/uuid'

/** 历史只在详情展开，预览旧版不会切换库内或作品内的当前引用。 */
const props = defineProps<{ asset: StudioAsset; selectable?: boolean }>()
const emit = defineEmits<{
  close: []
  choose: [asset: StudioAsset]
  changed: []
}>()
const { data, loading, error, reload } = useResource((signal) =>
  libraryApi.detail(props.asset.id, signal),
)
const auth = useAuthStore()
const tab = ref('preview'),
  selected = ref<StudioAsset>()
const current = computed(
  () => selected.value ?? data.value?.asset ?? props.asset,
)
const mutation = useMutation()
function previewVersion(version: StudioAsset) {
  selected.value = version
  tab.value = 'preview'
}
let archiveAttempt: { signature: string; key: string } | undefined
async function archive() {
  if (!data.value || mutation.busy.value) return
  const archived = !data.value.archived
  try {
    await ElMessageBox.confirm(
      archived
        ? `归档「${props.asset.name}」后，已有作品和历史成片仍可使用。素材中心默认不再展示，你可在详情恢复。`
        : `恢复「${props.asset.name}」到素材库？`,
      archived ? '归档素材' : '恢复素材',
      {
        confirmButtonText: archived ? '归档' : '恢复',
        cancelButtonText: '取消',
        type: archived ? 'warning' : 'info',
      },
    )
  } catch {
    return
  }
  const body = { expectedVersionId: data.value.currentVersionId, archived }
  const signature = JSON.stringify(body)
  if (archiveAttempt?.signature !== signature)
    archiveAttempt = { signature, key: createUuid() }
  if (
    await mutation.run(() =>
      libraryApi.archive(props.asset.id, {
        ...body,
        requestKey: archiveAttempt!.key,
      }),
    )
  ) {
    emit('changed')
    await reload()
  }
}
</script>
<template>
  <AppDrawer
    :model-value="true"
    :title="asset.name"
    size="min(880px, 96vw)"
    @update:model-value="emit('close')"
  >
    <template #toolbar
      ><el-tabs v-model="tab" class="library-tabs" aria-label="素材详情"
        ><el-tab-pane label="设定与预览" name="preview" /><el-tab-pane
          label="造型与版本"
          name="versions" /><el-tab-pane
          label="使用位置"
          name="usage" /></el-tabs
    ></template>
    <ResourceStatus
      :loading="loading"
      :error="error"
      :has-data="!!data"
      @retry="reload"
    />
    <el-alert
      v-if="mutation.error.value"
      type="error"
      :title="mutation.error.value"
      :closable="false"
    />
    <el-alert
      v-if="data?.archived"
      type="info"
      title="此素材已归档，已有作品引用仍然有效。"
      :closable="false"
    />
    <div v-if="tab === 'preview'" class="form-stack">
      <p>
        {{ current.variantName || '默认设定' }} · 版本
        {{ current.version ?? '—' }}
      </p>
      <StudioMedia
        v-if="current.fileId && auth.can('files.read')"
        :project="current.project"
        :asset="current.id"
        :kind="mediaKind(current.kind)"
        controls
      />
      <ExpandableText
        :text="current.description || '尚未补充设定'"
        label="设定"
        :lines="6"
      />
      <p v-if="current.voice">默认声音 · {{ current.voice }}</p>
      <StudioMedia
        v-if="current.voicePreviewAssetId && auth.can('files.read')"
        :project="null"
        :asset="current.voicePreviewAssetId"
        kind="audio"
        controls
      />
      <StudioMedia
        v-else-if="current.voicePreviewJob && auth.can('files.read')"
        :project="current.project"
        :job="current.voicePreviewJob"
        kind="audio"
        controls
      />
      <p v-if="current.origin" class="studio-meta">
        来源于个人库「{{ current.origin.name }}」，本片使用固定版本。
      </p>
    </div>
    <div v-if="tab === 'versions'" class="form-stack">
      <section
        v-for="variant in data?.variants ?? []"
        :key="variant.id"
        class="form-stack"
      >
        <h3>{{ variant.name }}</h3>
        <div class="library-version-list">
          <div
            v-for="version in data?.versions.filter(
              (item) => item.variantId === variant.id,
            )"
            :key="version.id"
            class="library-version-row"
          >
            <span
              >版本 {{ version.version
              }}<el-tag
                v-if="variant.currentVersionId === version.id"
                size="small"
                >该造型当前版</el-tag
              ></span
            ><el-button @click="previewVersion(version)">查看此版本</el-button>
          </div>
        </div>
      </section>
      <div v-if="!data?.variants.length" class="library-version-list">
        <div
          v-for="version in data?.versions ?? []"
          :key="version.id"
          class="library-version-row"
        >
          <span>版本 {{ version.version }}</span
          ><el-button @click="previewVersion(version)">查看此版本</el-button>
        </div>
      </div>
    </div>
    <StudioAssetUsage
      v-if="tab === 'usage'"
      :key="current.id"
      :asset="current.id"
      :project="current.project"
    />
    <template #footer
      ><div class="dialog-actions">
        <el-button
          v-if="!asset.project && data && auth.can('studio.assets.write')"
          :disabled="mutation.busy.value"
          :type="data.archived ? 'default' : 'danger'"
          @click="archive"
          >{{ data.archived ? '恢复素材' : '归档素材' }}</el-button
        ><el-button :disabled="mutation.busy.value" @click="emit('close')"
          >关闭</el-button
        ><el-button
          v-if="selectable && !data?.archived"
          type="primary"
          @click="emit('choose', current)"
          >使用此版本</el-button
        >
      </div></template
    >
  </AppDrawer>
</template>
<style scoped src="../../../../assets/styles/studio-library.css"></style>
