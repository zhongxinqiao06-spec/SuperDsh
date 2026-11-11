<script setup lang="ts">
import { ref, watch } from 'vue'
import { toolsApi } from '@/api/tools/tools-api'
import { skillsApi } from '@/api/skills/skills-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { usePreferences } from '@/store/modules/preferences'
import type { ResourceBase, ResourceHistory } from '@/types/tools/tools'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
/** 回退必须明确选择历史版本，并使用当前版本做并发校验。 */
const props = defineProps<{
    resource: ResourceBase
    kind: 'tools' | 'skills'
  }>(),
  emit = defineEmits<{ close: []; changed: [] }>(),
  { tr } = usePreferences()
const page = ref(1),
  pending = ref<number | null>(null),
  mutation = useMutation()
const history = useResource<ResourceHistory<ResourceBase>>((signal) =>
  props.kind === 'tools'
    ? toolsApi.versions(props.resource.id, page.value, signal)
    : skillsApi.versions(props.resource.id, page.value, signal),
)
watch(page, () => void history.reload())
async function restore() {
  if (pending.value === null || !history.data.value) return
  const api = props.kind === 'tools' ? toolsApi : skillsApi
  if (
    await mutation.run(() =>
      api.restore(
        props.resource.id,
        history.data.value!.currentVersion,
        pending.value!,
      ),
    )
  ) {
    pending.value = null
    await history.reload()
    emit('changed')
  }
}
</script>
<template>
  <el-dialog
    :model-value="true"
    :title="`${resource.name} · ${tr('版本历史', 'Version history')}`"
    width="min(760px,94vw)"
    @update:model-value="emit('close')"
    ><ResourceStatus
      :loading="history.loading.value"
      :error="history.error.value"
      @retry="history.reload"
    /><el-table :data="history.data.value?.items ?? []"
      ><el-table-column
        prop="version"
        :label="tr('版本', 'Version')"
        width="90"
      /><el-table-column
        prop="name"
        :label="tr('名称', 'Name')"
      /><el-table-column
        prop="updatedAt"
        :label="tr('更新时间', 'Updated')"
      /><el-table-column :label="tr('操作', 'Actions')"
        ><template #default="{ row }"
          ><el-tag v-if="row.version === history.data.value?.currentVersion">{{
            tr('当前版本', 'Current version')
          }}</el-tag
          ><el-button v-else link @click="pending = row.version">{{
            tr('还原为新版本', 'Restore as new revision')
          }}</el-button></template
        ></el-table-column
      ></el-table
    ><el-pagination
      v-model:current-page="page"
      :total="history.data.value?.total ?? 0"
      :page-size="10"
      layout="total, prev, pager, next"
    /><ManagementDialog
      :model-value="pending !== null"
      :title="tr('确认还原历史配置', 'Restore historical configuration')"
      :busy="mutation.busy.value"
      :error="mutation.error.value"
      @update:model-value="pending = null"
      @submit="restore"
      ><p>
        {{
          tr(
            '当前配置将追加一个新版本，既有历史保持不变。',
            'This creates a new revision from the selected snapshot and preserves history.',
          )
        }}
        {{ pending }}
      </p></ManagementDialog
    ></el-dialog
  >
</template>
