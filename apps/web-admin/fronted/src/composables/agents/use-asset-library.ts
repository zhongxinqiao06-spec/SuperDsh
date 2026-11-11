import { onScopeDispose, ref, watch } from 'vue'
import { agentsApi } from '@/api/agents/agents-api'
import { useMutation } from '@/composables/use-mutation'
import { assetBase64 } from '@/utils/agents/agent-drafts'
import { useAuthStore } from '@/store/modules/auth-store'
import type { AgentAsset, AssetKind } from '@/types/agents/agents'

/** 资料上传与预览生命周期，下载地址只保留在当前页面并及时释放。 */
export function useAssetLibrary(
  reload: () => Promise<void>,
  onUploaded?: (asset: AgentAsset) => Promise<void>,
) {
  const auth = useAuthStore(),
    mutation = useMutation(),
    uploading = ref(false),
    kind = ref<AssetKind>('knowledge'),
    file = ref<File | null>(null),
    name = ref(''),
    preview = ref<AgentAsset | null>(null),
    previewUrl = ref('')
  let alive = true
  // 上传成功而后续关联失败时只重试关联，不能重复创建资料。
  let uploaded: AgentAsset | null = null
  watch(
    [file, kind, name],
    () => {
      uploaded = null
    },
    { flush: 'sync' },
  )
  function clearPreview(): void {
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
    preview.value = null
  }
  function choose(event: Event): void {
    const target = event.target
    file.value =
      target instanceof HTMLInputElement ? (target.files?.[0] ?? null) : null
    name.value = file.value?.name ?? ''
  }
  async function upload(): Promise<void> {
    const chosen = file.value
    if (!chosen) {
      mutation.error.value = '请选择文件'
      return
    }
    const allowed =
      kind.value === 'knowledge'
        ? ['.txt', '.md', '.csv', '.xlsx', '.docx', '.pdf']
        : [
            kind.value === 'spreadsheet-template'
              ? '.xlsx'
              : kind.value === 'document-template'
                ? '.docx'
                : '.pptx',
          ]
    const extension = chosen.name.match(/\.[^.]+$/)?.[0]?.toLowerCase()
    if (!extension || !allowed.includes(extension)) {
      mutation.error.value = '所选文件类型与资料类型不一致。'
      return
    }
    if (!name.value.trim().toLowerCase().endsWith(extension)) {
      mutation.error.value = `名称请保留原文件扩展名 ${extension}。`
      return
    }
    const generation = auth.generation,
      uploadName = name.value.trim(),
      uploadKind = kind.value
    if (
      await mutation.run(async () => {
        if (!uploaded) {
          const content = await assetBase64(chosen)
          if (!alive || generation !== auth.generation) return
          if (
            file.value !== chosen ||
            name.value.trim() !== uploadName ||
            kind.value !== uploadKind
          )
            throw new Error('上传草稿已改变，请重新提交。')
          const result = await agentsApi.upload(uploadName, uploadKind, content)
          if (!alive || generation !== auth.generation) return
          uploaded = result.asset
        }
        if (onUploaded) await onUploaded(uploaded)
      })
    ) {
      uploading.value = false
      file.value = null
      name.value = ''
      await reload()
    }
  }
  async function download(asset: AgentAsset): Promise<void> {
    const generation = auth.generation
    await mutation.run(async () => {
      const value = await agentsApi.download(asset.id)
      if (!alive || generation !== auth.generation) return
      const bytes = Uint8Array.from(atob(value.contentBase64), (character) =>
        character.charCodeAt(0),
      )
      const url = URL.createObjectURL(
        new Blob([bytes], { type: value.mediaType }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = value.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }
  async function showPreview(asset: AgentAsset): Promise<void> {
    clearPreview()
    preview.value = asset
    if (
      ![
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ].includes(asset.mediaType)
    )
      return
    const generation = auth.generation
    await mutation.run(async () => {
      const value = await agentsApi.preview(asset.id)
      if (
        !alive ||
        generation !== auth.generation ||
        preview.value?.id !== asset.id
      )
        return
      const bytes = Uint8Array.from(atob(value.contentBase64), (character) =>
        character.charCodeAt(0),
      )
      previewUrl.value = URL.createObjectURL(
        new Blob([bytes], { type: value.mediaType }),
      )
    })
  }
  watch(
    () => auth.generation,
    () => {
      clearPreview()
      uploading.value = false
      file.value = null
      name.value = ''
    },
  )
  onScopeDispose(() => {
    alive = false
    clearPreview()
  })
  return {
    mutation,
    uploading,
    kind,
    file,
    name,
    preview,
    previewUrl,
    clearPreview,
    choose,
    upload,
    download,
    showPreview,
  }
}
