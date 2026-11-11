import { onScopeDispose, ref, watch } from 'vue'
import { knowledgeApi } from '@/api/knowledge/knowledge-api'
import { useAssetLibrary } from '@/composables/agents/use-asset-library'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import { knowledgeDraft } from '@/utils/knowledge/knowledge-drafts'
import type { AgentAsset } from '@/types/agents/agents'
import type { KnowledgeBase } from '@/types/knowledge/knowledge'

/** 知识库文件独立用例：CAS 关联成功后重建索引；移出不删除原文件，失败保留可重试状态。 */
export function useKnowledgeFiles(reload: () => Promise<void>) {
  const auth = useAuthStore(),
    target = ref<KnowledgeBase | null>(null),
    mutation = useMutation(),
    indexing = useMutation(),
    notice = ref('')
  let alive = true,
    selection = 0
  const assets = useAssetLibrary(reload, async (asset) => {
    const base = target.value
    if (!base)
      throw new Error('知识库文件窗口已关闭，请重新打开后关联已上传的资料。')
    await update([...new Set([...base.assetIds, asset.id])])
  })
  function open(base: KnowledgeBase): void {
    selection += 1
    target.value = { ...base, assetIds: [...base.assetIds] }
    mutation.error.value = ''
    indexing.error.value = ''
    notice.value = ''
    assets.mutation.error.value = ''
    assets.uploading.value = false
    assets.file.value = null
    assets.clearPreview()
  }
  function close(): void {
    if (
      mutation.busy.value ||
      indexing.busy.value ||
      assets.mutation.busy.value
    )
      return
    selection += 1
    target.value = null
    assets.uploading.value = false
    assets.file.value = null
    assets.clearPreview()
  }
  async function reindex(): Promise<void> {
    const base = target.value,
      token = selection,
      generation = auth.generation
    if (!base) return
    notice.value = ''
    if (await indexing.run(() => knowledgeApi.index(base.id))) {
      if (alive && generation === auth.generation && token === selection)
        notice.value = '资料索引已更新。'
      await reload()
    }
  }
  async function update(ids: string[]): Promise<void> {
    const base = target.value,
      token = selection,
      generation = auth.generation
    if (!base || mutation.busy.value)
      throw new Error('知识库文件状态已变化，请刷新后重试。')
    const success = await mutation.run(async () => {
      const result = await knowledgeApi.save(
        { ...knowledgeDraft(base), assetIds: ids },
        base.id,
      )
      if (!alive || generation !== auth.generation || token !== selection)
        return
      target.value = result.knowledgeBase
      await reload()
    })
    if (!success) throw new Error(mutation.error.value || '资料关联未完成。')
    if (alive && generation === auth.generation && token === selection)
      await reindex()
  }
  async function remove(asset: AgentAsset): Promise<void> {
    if (!target.value) return
    try {
      await update(target.value.assetIds.filter((id) => id !== asset.id))
    } catch {
      /* 关联错误保留在 mutation 中供窗口显示。 */
    }
  }
  watch(
    () => auth.generation,
    () => {
      selection += 1
      target.value = null
      notice.value = ''
    },
  )
  onScopeDispose(() => {
    alive = false
    selection += 1
  })
  return {
    target,
    mutation,
    indexing,
    notice,
    assets,
    open,
    close,
    reindex,
    remove,
  }
}
