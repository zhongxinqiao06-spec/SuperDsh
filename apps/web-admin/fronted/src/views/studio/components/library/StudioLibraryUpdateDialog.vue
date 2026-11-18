<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { libraryApi } from '@/api/studio/library-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { createUuid } from '@/utils/uuid'
import type { LibraryField, LibraryProjectResult } from '@/types/studio/library'
import type { StudioAsset } from '@/types/studio/studio'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ExpandableText from '@/components/base/ExpandableText.vue'
import StudioMedia from '../StudioMedia.vue'

/** 比较本片和库内更新，冲突字段需额外确认；不自动采用或重新生成成果。 */
const props = defineProps<{
  project: string
  asset: StudioAsset
  save: () => Promise<void>
}>()
const emit = defineEmits<{
  close: []
  applied: [result: LibraryProjectResult]
}>()
const mutation = useMutation()
const resource = useResource(async (signal) => {
  await props.save()
  return libraryApi.previewUpdate(props.project, props.asset.id, signal)
})
const fields = ref<LibraryField[]>([]),
  overwrite = ref(false)
function selectField(key: LibraryField, selected: unknown) {
  if (mutation.busy.value) return
  fields.value =
    selected === true
      ? [...new Set([...fields.value, key])]
      : fields.value.filter((field) => field !== key)
  overwrite.value = false
}
watch(
  () => resource.data.value,
  (value) => {
    fields.value =
      value?.fields
        .filter((field) => field.changed && !field.conflict)
        .map((field) => field.key) ?? []
    overwrite.value = false
  },
)
const conflicts = computed(
  () =>
    resource.data.value?.fields.filter(
      (field) => field.conflict && fields.value.includes(field.key),
    ) ?? [],
)
function display(value: unknown, key: LibraryField) {
  if (key === 'voice' && value && typeof value === 'object' && 'voice' in value)
    return String(value.voice || '未设置声音')
  return typeof value === 'string' && value ? value : '未设置'
}
function hasImage(value: unknown) {
  return (
    !!value && typeof value === 'object' && 'fileId' in value && !!value.fileId
  )
}
let attempt: { signature: string; key: string } | undefined
async function apply() {
  const preview = resource.data.value
  if (!preview) return
  const body = {
    assetId: props.asset.id,
    sourceVersionId: preview.sourceVersionId,
    expectedRevision: preview.projectRevision,
    fields: fields.value,
    overwriteConflicts: overwrite.value,
  }
  const signature = JSON.stringify(body)
  if (attempt?.signature !== signature)
    attempt = { signature, key: createUuid() }
  let result: LibraryProjectResult | undefined
  if (
    (await mutation.run(async () => {
      result = await libraryApi.applyUpdate(props.project, {
        ...body,
        requestKey: attempt!.key,
      })
    })) &&
    result
  )
    emit('applied', result)
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="asset.name + ' · 比较库内更新'"
    width="min(920px, calc(100vw - 32px))"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :submit-disabled="!fields.length || (!!conflicts.length && !overwrite)"
    submit-text="采用所选更新"
    @submit="apply"
    @update:model-value="emit('close')"
  >
    <ResourceStatus
      :loading="resource.loading.value"
      :error="resource.error.value"
      :has-data="!!resource.data.value"
      @retry="resource.reload"
    />
    <template v-if="resource.data.value">
      <p>只替换你勾选的内容。未勾选的声音、设定与参考图继续保留。</p>
      <p
        v-if="!resource.data.value.fields.some((field) => field.changed)"
        class="studio-meta"
      >
        没有待采用的库内更新，本片自有修改保留。
      </p>
      <!-- 对比正文不是选项组内容，避免控件的零字号布局影响普通文本。 -->
      <div class="form-stack">
        <section
          v-for="field in resource.data.value.fields.filter(
            (item) => item.changed,
          )"
          :key="field.key"
          class="form-stack library-difference"
        >
          <el-checkbox
            :model-value="fields.includes(field.key)"
            :disabled="mutation.busy.value"
            @change="selectField(field.key, $event)"
            >更新{{ field.label }}</el-checkbox
          >
          <el-alert
            v-if="field.conflict"
            type="warning"
            :closable="false"
            title="本片和素材库都修改过这一项，请比较后再决定。"
          />
          <div class="library-detail-grid">
            <section class="form-stack">
              <strong>本片当前内容</strong
              ><template v-if="field.key === 'appearance'"
                ><StudioMedia
                  v-if="hasImage(field.current)"
                  :project="project"
                  :asset="asset.id"
                  kind="image"
                  controls
                />
                <p v-else>没有参考图</p></template
              ><ExpandableText
                v-else
                :text="display(field.current, field.key)"
                :lines="5"
                label="本片内容"
              />
            </section>
            <section class="form-stack">
              <strong>素材库新内容</strong
              ><template v-if="field.key === 'appearance'"
                ><StudioMedia
                  v-if="hasImage(field.incoming)"
                  :project="null"
                  :asset="resource.data.value.sourceVersionId"
                  kind="image"
                  controls
                />
                <p v-else>没有参考图</p></template
              ><ExpandableText
                v-else
                :text="display(field.incoming, field.key)"
                :lines="5"
                label="素材库内容"
              />
            </section>
          </div>
        </section>
      </div>
      <el-checkbox v-if="conflicts.length" v-model="overwrite"
        >我确认用所选库内内容替换本片对应修改</el-checkbox
      >
      <el-alert
        type="info"
        :closable="false"
        :title="`涉及 ${resource.data.value.affected.shots.length} 个镜头、${resource.data.value.affected.lines.length} 句台词。已有视频和配音继续保留，请在需要时自行重做。`"
      />
    </template>
  </ManagementDialog>
</template>
<style scoped src="../../../../assets/styles/studio-library.css"></style>
<style scoped>
.library-difference {
  padding-block: var(--field-gap);
  border-block-start: 1px solid var(--border);
}
</style>
