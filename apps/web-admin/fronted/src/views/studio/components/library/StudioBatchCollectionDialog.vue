<script setup lang="ts">
import { onScopeDispose, ref } from 'vue'
import { sessionController } from '@/store/session-controller'
import type { StudioAsset } from '@/types/studio/studio'
import { libraryApi } from '@/api/studio/library-api'
import { createUuid } from '@/utils/uuid'
import { useMutation } from '@/composables/use-mutation'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'

/** 批量收藏逐项记录成功结果，重试沿用原请求键，不重复复制已经成功的素材。 */
const props = defineProps<{ assets: StudioAsset[] }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const mutation = useMutation()
const completed = ref<string[]>([])
const keys = new Map(props.assets.map((asset) => [asset.id, createUuid()]))
let alive = true
onScopeDispose(() => {
  alive = false
})
async function collect() {
  const generation = sessionController.generation
  if (
    await mutation.run(async () => {
      for (const asset of props.assets) {
        if (!alive || generation !== sessionController.generation)
          throw new Error('页面或账号已变化，已停止后续收藏')
        if (completed.value.includes(asset.id)) continue
        await libraryApi.collect({
          sourceVersionId: asset.id,
          mode: 'new',
          requestKey: keys.get(asset.id)!,
        })
        if (!alive || generation !== sessionController.generation) return
        completed.value.push(asset.id)
      }
    })
  )
    emit('saved')
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    title="批量收藏到素材库"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :submit-text="completed.length ? '继续收藏剩余素材' : '确认收藏'"
    @submit="collect"
    @update:model-value="emit('close')"
  >
    <p>
      收藏以下
      {{ assets.length }}
      项当前采用的设定与参考文件，原作品保持不变。已有库来源的素材请单独比较后存回。
    </p>
    <ul class="collection-progress">
      <li v-for="asset in assets" :key="asset.id">
        <span>{{ asset.name }} · 版本 {{ asset.version ?? '—' }}</span
        ><el-tag :type="completed.includes(asset.id) ? 'success' : 'info'">{{
          completed.includes(asset.id) ? '已收藏' : '待收藏'
        }}</el-tag>
      </li>
    </ul>
    <p v-if="completed.length" role="status">
      已完成 {{ completed.length }} /
      {{ assets.length }}。如中途失败，重试只处理尚未成功的项目。
    </p>
  </ManagementDialog>
</template>
<style scoped>
.collection-progress {
  display: grid;
  gap: var(--control-gap);
  list-style: none;
  margin: 0;
  padding: 0;
}
.collection-progress li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--field-gap);
}
.collection-progress span {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
