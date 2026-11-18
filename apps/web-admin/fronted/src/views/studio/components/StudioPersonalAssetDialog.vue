<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { studioApi } from '@/api/studio/studio-api'
import { uploadFile } from '@/api/files/upload-api'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { assetKinds, mediaKind } from '@/utils/studio/media-labels'
import type { StudioAsset } from '@/types/studio/studio'
import { createUuid } from '@/utils/uuid'
const props = defineProps<{
  asset?: StudioAsset
  kinds?: Partial<Record<StudioAsset['kind'], string>>
}>()
const availableKinds = computed(() => props.kinds ?? assetKinds)
const emit = defineEmits<{ close: []; saved: [] }>()
const auth = useAuthStore(),
  mutation = useMutation()
const canUpload = computed(
  () => auth.can('files.read') && auth.can('files.write'),
)
const name = ref(props.asset?.name ?? ''),
  kind = ref<StudioAsset['kind']>(
    props.asset?.kind ??
      ((Object.keys(props.kinds ?? assetKinds)[0] ??
        'character') as StudioAsset['kind']),
  ),
  description = ref(props.asset?.description ?? ''),
  voice = ref(props.asset?.voice ?? '')
const file = ref<File>(),
  fileId = ref<string | null>(props.asset?.fileId ?? null)
const mediaRequired = computed(() =>
  ['image', 'video', 'audio', 'music'].includes(kind.value),
)
const changed = computed(
  () =>
    !props.asset ||
    !!file.value ||
    name.value.trim() !== props.asset.name ||
    description.value !== props.asset.description ||
    voice.value.trim() !== props.asset.voice ||
    fileId.value !== props.asset.fileId,
)
watch(kind, () => {
  file.value = undefined
  fileId.value = null
})
function chooseFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0]
  fileId.value = null
  if (!name.value && file.value) name.value = file.value.name.slice(0, 120)
}
async function save() {
  // 绑定失败可用同一个文件 ID 重试，避免重新上传大文件。
  if (
    await mutation.run(async () => {
      if (file.value && !fileId.value) {
        fileId.value = (await uploadFile(file.value)).fileId ?? null
        if (!fileId.value) throw new Error('文件上传未完成')
      }
      const body = {
        name: name.value.trim(),
        description: description.value,
        kind: kind.value,
        voice: kind.value === 'character' ? voice.value.trim() : '',
        fileId: fileId.value,
        parent: props.asset?.id ?? null,
        project: null,
        expectedVersionId: props.asset?.id,
      }
      const signature = JSON.stringify(body)
      if (attempt?.signature !== signature)
        attempt = { signature, key: createUuid() }
      await studioApi.asset({ ...body, requestKey: attempt.key })
    })
  )
    emit('saved')
}
let attempt: { signature: string; key: string } | undefined
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="asset ? '创建素材新版本' : '新增个人素材'"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :dirty="changed && Boolean(name || description || voice || file)"
    :submit-disabled="
      !changed || !name.trim() || (mediaRequired && !file && !fileId)
    "
    @update:model-value="emit('close')"
    @submit="save"
  >
    <label class="field"
      >素材类型<el-select
        v-model="kind"
        aria-label="素材类型"
        :disabled="Boolean(asset)"
        ><el-option
          v-for="(label, k) in availableKinds"
          :key="k"
          :label="label"
          :value="k"
          :disabled="
            !canUpload && ['image', 'video', 'audio', 'music'].includes(k)
          " /></el-select
    ></label>
    <label class="field"
      >素材名称<el-input v-model="name" maxlength="120" aria-label="素材名称"
    /></label>
    <label class="field"
      >设定说明<el-input
        v-model="description"
        type="textarea"
        maxlength="12000"
        :rows="3"
        aria-label="设定说明"
    /></label>
    <label v-if="kind === 'character'" class="field"
      >默认音色（可选）<el-input
        v-model="voice"
        maxlength="240"
        placeholder="供应商音色 ID"
        aria-label="默认音色"
    /></label>
    <label v-if="canUpload" class="field"
      >参考文件{{ mediaRequired ? '' : '（可选）'
      }}<input
        :key="kind"
        class="native-control"
        type="file"
        :accept="mediaKind(kind) + '/*'"
        @change="chooseFile"
    /></label>
  </ManagementDialog>
</template>
