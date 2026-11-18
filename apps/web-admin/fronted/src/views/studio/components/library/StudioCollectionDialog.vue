<script setup lang="ts">
import { computed, ref } from 'vue'
import { libraryApi } from '@/api/studio/library-api'
import { useMutation } from '@/composables/use-mutation'
import { useResource } from '@/composables/use-resource'
import { createUuid } from '@/utils/uuid'
import { assetKinds } from '@/utils/studio/media-labels'
import type { StudioAsset } from '@/types/studio/studio'
import type { CollectionMode } from '@/types/studio/library'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import StudioAssetCard from './StudioAssetCard.vue'

/** 收藏只保存已采用版本；更新原条目必须有可验证来源，并显式选择操作方式。 */
const props = defineProps<{ asset: StudioAsset; variant?: boolean }>()
const emit = defineEmits<{ close: []; saved: [asset: StudioAsset] }>()
const detail = useResource((signal) =>
  libraryApi.detail(props.asset.id, signal),
)
const mutation = useMutation()
const mode = ref<CollectionMode>(
  props.variant ? 'variant' : props.asset.origin ? 'update' : 'new',
)
const variantName = ref('')
const origin = computed(() => detail.data.value?.origin ?? props.asset.origin)
const canVariant = computed(
  () =>
    ['character', 'scene', 'prop'].includes(props.asset.kind) &&
    (!!origin.value || !props.asset.project),
)
let attempt: { signature: string; key: string } | undefined
async function collect() {
  if (!detail.data.value) return
  const body = {
    sourceVersionId: props.asset.id,
    mode: mode.value,
    expectedVersionId:
      mode.value === 'new'
        ? undefined
        : (origin.value?.currentVersionId ?? detail.data.value.asset.id),
    variantName:
      mode.value === 'variant' ? variantName.value.trim() : undefined,
  }
  const signature = JSON.stringify(body)
  if (attempt?.signature !== signature)
    attempt = { signature, key: createUuid() }
  let saved: StudioAsset | undefined
  if (
    (await mutation.run(async () => {
      saved = (await libraryApi.collect({ ...body, requestKey: attempt!.key }))
        .asset
    })) &&
    saved
  )
    emit('saved', saved)
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="asset.project ? '保存到素材库' : '新增造型或环境变体'"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :submit-disabled="
      !detail.data.value || (mode === 'variant' && !variantName.trim())
    "
    submit-text="确认保存"
    @submit="collect"
    @update:model-value="emit('close')"
  >
    <ResourceStatus
      :loading="detail.loading.value"
      :error="detail.error.value"
      :has-data="!!detail.data.value"
      @retry="detail.reload"
    />
    <div v-if="detail.data.value" class="library-detail-grid">
      <StudioAssetCard :asset="asset" />
      <div class="form-stack">
        <div class="field">
          <span>保存方式</span
          ><el-radio-group
            v-model="mode"
            class="stack"
            aria-label="保存方式"
            :disabled="mutation.busy.value"
            ><el-radio v-if="asset.project" value="new"
              >收藏为新{{ assetKinds[asset.kind] }}</el-radio
            ><el-radio v-if="origin" value="update"
              >更新「{{ origin.name }}」的已有造型</el-radio
            ><el-radio v-if="canVariant" value="variant">{{
              asset.kind === 'scene' ? '保存为新的环境变体' : '保存为新的造型'
            }}</el-radio></el-radio-group
          >
        </div>
        <label v-if="mode === 'variant'" class="field"
          >{{ asset.kind === 'scene' ? '环境变体名称' : '造型名称'
          }}<el-input
            v-model="variantName"
            maxlength="120"
            :placeholder="
              asset.kind === 'scene'
                ? '例如：雨夜、日景'
                : '例如：太空服、日常装'
            "
        /></label>
        <p>
          保存当前采用的参考图、设定{{
            asset.kind === 'character' ? '和声音' : ''
          }}。未采用的生成候选不会一起收藏。
        </p>
        <el-alert
          v-if="mode !== 'new'"
          type="info"
          :closable="false"
          title="保存新版本不会自动修改已经引用它的作品，也不会重新生成视频或配音。"
        />
      </div>
    </div>
  </ManagementDialog>
</template>
<style scoped src="../../../../assets/styles/studio-library.css"></style>
