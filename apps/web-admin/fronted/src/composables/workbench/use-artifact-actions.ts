import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { resultApi, type ArtifactView } from '@/api/workbench/result-api'
import { useAuthStore } from '@/store/modules/auth-store'
import { errorMessage } from '@/utils/errors'

/** 共享成果查看器；关闭预览、切换会话或账号时撤销旧对象 URL 和尚未完成的预览。 */
export function useArtifactActions(session: Ref<string>) {
  const auth = useAuthStore()
  const error = ref(''),
    previewUrl = ref(''),
    previewType = ref(''),
    previewName = ref('')
  let controller = new AbortController(),
    generation = 0,
    previewRequest = 0
  function closePreview() {
    previewRequest++
    revokePreview()
  }
  function revokePreview() {
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
  }
  function save(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob),
      link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function preview(artifact: ArtifactView) {
    error.value = ''
    revokePreview()
    const started = generation,
      request = ++previewRequest
    try {
      const value = await resultApi.preview(
        session.value,
        artifact.id,
        controller.signal,
      )
      if (started !== generation || request !== previewRequest) return
      if (
        !['application/pdf', 'image/png', 'image/jpeg'].includes(
          value.mediaType,
        )
      )
        throw new Error('不支持此预览类型')
      revokePreview()
      previewUrl.value = URL.createObjectURL(
        new Blob(
          [
            Uint8Array.from(atob(value.contentBase64), (char) =>
              char.charCodeAt(0),
            ),
          ],
          { type: value.mediaType },
        ),
      )
      previewType.value = value.mediaType
      previewName.value = value.name
    } catch (cause) {
      if (started === generation && request === previewRequest)
        error.value = errorMessage(cause)
    }
  }
  async function download(artifact: ArtifactView) {
    error.value = ''
    const started = generation
    try {
      const blob = await resultApi.artifact(
        session.value,
        artifact.id,
        controller.signal,
      )
      if (started === generation && !controller.signal.aborted)
        save(blob, artifact.name)
    } catch (cause) {
      if (started === generation && !controller.signal.aborted)
        error.value = errorMessage(cause)
    }
  }
  async function attachment(file: string) {
    const started = generation
    try {
      const blob = await resultApi.attachment(
        session.value,
        file,
        controller.signal,
      )
      if (started === generation && !controller.signal.aborted) save(blob, file)
    } catch (cause) {
      if (started === generation && !controller.signal.aborted)
        error.value = errorMessage(cause)
    }
  }
  function reset() {
    generation++
    controller.abort()
    controller = new AbortController()
    error.value = ''
    closePreview()
  }
  watch([session, () => auth.generation, () => auth.can('files.read')], reset, {
    flush: 'sync',
  })
  onScopeDispose(reset)
  return {
    error,
    previewUrl,
    previewType,
    previewName,
    preview,
    download,
    attachment,
    closePreview,
  }
}
