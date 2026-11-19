import { computed, onScopeDispose, ref } from 'vue'
import { useAuthStore } from '@/store/modules/auth-store'
import { uploadFile } from '@/api/files/upload-api'
import { studioApi } from '@/api/studio/studio-api'
import { createUuid } from '@/utils/uuid'
import { useMutation } from '@/composables/use-mutation'
import type { StudioAsset } from '@/types/studio/studio'

/** 上传和个人库选择固定具体素材版本；移除引用不删除用户文件或素材。 */
export function useQuickReferences(options: {
  selected: () => string[]
  limit: () => number
  editable: () => boolean
  add: (asset: StudioAsset) => void
}) {
  const auth = useAuthStore()
  const mutation = useMutation()
  const controller = new AbortController()
  const pickerOpen = ref(false),
    progress = ref(0)
  const canUpload = computed(
    () =>
      auth.can('files.write') &&
      auth.can('files.read') &&
      auth.can('studio.assets.write'),
  )
  const canChoose = computed(() => auth.can('studio.assets.read'))
  const uploaded = new Map<File, string>()
  const keys = new Map<string, string>()
  async function resolve(asset: StudioAsset) {
    if (!options.editable()) throw new Error('当前草稿不可编辑。')
    if (!asset.fileId)
      throw new Error('该设定尚无参考图片，请先在素材库生成并采用形象。')
    if (options.selected().includes(asset.id)) return asset
    if (options.selected().length >= options.limit())
      throw new Error(`当前方式最多使用 ${options.limit()} 张参考图。`)
    return asset
  }
  function add(asset: StudioAsset) {
    if (!options.selected().includes(asset.id)) options.add(asset)
    pickerOpen.value = false
  }
  async function upload(files: File[]) {
    if (!options.editable() || !canUpload.value || !files.length) return
    await mutation.run(async () => {
      if (options.selected().length + files.length > options.limit())
        throw new Error(`上传与已选素材合计最多 ${options.limit()} 张。`)
      if (
        files.some(
          (file) =>
            !['image/jpeg', 'image/png', 'image/webp'].includes(file.type),
        )
      )
        throw new Error('请选择 JPG、PNG 或 WebP 图片。')
      for (const file of files) {
        progress.value = 0
        let fileId = uploaded.get(file)
        if (!fileId) {
          fileId = (
            await uploadFile(file, controller.signal, (value) => {
              progress.value = value
            })
          ).fileId
          uploaded.set(file, fileId)
        }
        controller.signal.throwIfAborted()
        if (!keys.has(fileId)) keys.set(fileId, createUuid())
        const asset = await studioApi.asset({
          kind: 'image',
          name: file.name.replace(/\.[^.]+$/u, '').slice(0, 120) || '参考图',
          description: '',
          voice: '',
          parent: null,
          project: null,
          fileId,
          requestKey: keys.get(fileId)!,
        })
        controller.signal.throwIfAborted()
        options.add(asset)
      }
    })
  }
  onScopeDispose(() => controller.abort())
  return {
    mutation,
    pickerOpen,
    progress,
    canUpload,
    canChoose,
    resolve,
    add,
    upload,
  }
}
