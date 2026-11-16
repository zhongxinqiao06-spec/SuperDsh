<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import StudioBriefFields from './StudioBriefFields.vue'
import type { StudioProject } from '@/types/studio/studio'
import { projectBrief } from '@/utils/studio/foundation'
import { studioApi } from '@/api/studio/studio-api'
import { newId } from '@/utils/studio/storyboard'
import { useMutation } from '@/composables/use-mutation'
/** 规格使用单独修订命令；外部更新不覆盖用户正编辑的表单。 */
const props = defineProps<{ project: StudioProject; disabled: boolean }>()
const emit = defineEmits<{ saved: []; draft: [value: boolean] }>()
const form = ref(projectBrief(props.project)),
  original = ref(JSON.stringify(form.value))
const dirty = computed(() => JSON.stringify(form.value) !== original.value)
const mutation = useMutation()
let attempt: { signature: string; key: string } | undefined
watch(dirty, (value) => emit('draft', value))
watch(
  () => props.project.revision,
  () => {
    if (!dirty.value) {
      form.value = projectBrief(props.project)
      original.value = JSON.stringify(form.value)
    }
  },
)
async function save() {
  const signature = JSON.stringify([props.project.revision, form.value])
  if (attempt?.signature !== signature) attempt = { signature, key: newId() }
  if (
    await mutation.run(async () => {
      await studioApi.updateBrief(
        props.project.id,
        props.project.revision,
        form.value,
        attempt!.key,
      )
    })
  ) {
    original.value = JSON.stringify(form.value)
    emit('draft', false)
    emit('saved')
  }
}
</script>
<template>
  <section class="panel studio-panel form-stack">
    <h2>作品构想与制作规格</h2>
    <p class="studio-meta">
      先确定故事方向和画面规格。修改这里不会重新生成镜头，也不会改变已导出的成片。
    </p>
    <el-alert
      v-if="mutation.error.value"
      :title="mutation.error.value"
      type="error"
      :closable="false"
    />
    <el-form :disabled="disabled || mutation.busy.value"
      ><StudioBriefFields v-model="form"
    /></el-form>
    <div class="toolbar">
      <el-button
        type="primary"
        :disabled="disabled || !dirty || !form.title.trim()"
        :loading="mutation.busy.value"
        @click="save"
        >保存制作规格</el-button
      >
    </div>
  </section>
</template>
