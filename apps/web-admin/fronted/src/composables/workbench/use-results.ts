import { onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  resultApi,
  type ArtifactView,
  type SkillRunView,
} from '@/api/workbench/result-api'
import { errorMessage } from '@/utils/errors'

/** 会话成果轮询带取消与代际，旧会话结果不会进入新会话。 */
export function useResults(session: Ref<string>) {
  const runs = ref<SkillRunView[]>([]),
    artifacts = ref<ArtifactView[]>([]),
    error = ref(''),
    previewUrl = ref(''),
    previewType = ref(''),
    previewName = ref('')
  let controller = new AbortController(),
    timer: ReturnType<typeof setTimeout> | undefined,
    generation = 0
  function closePreview() {
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
  async function reload() {
    const started = generation,
      id = session.value
    if (!id) return
    try {
      const [runData, artifactData] = await Promise.all([
        resultApi.runs(id, controller.signal),
        resultApi.artifacts(id, controller.signal),
      ])
      if (started !== generation) return
      runs.value = runData.items
      artifacts.value = artifactData.items
      error.value = ''
    } catch (cause) {
      if (started === generation && !controller.signal.aborted)
        error.value = errorMessage(cause)
    }
    if (started === generation && !controller.signal.aborted)
      timer = setTimeout(() => void reload(), 5000)
  }
  async function preview(artifact: ArtifactView) {
    const started = generation
    try {
      const value = await resultApi.preview(
        session.value,
        artifact.id,
        controller.signal,
      )
      if (started !== generation) return
      if (
        !['application/pdf', 'image/png', 'image/jpeg'].includes(
          value.mediaType,
        )
      )
        throw new Error('不支持此预览类型')
      closePreview()
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
      if (started === generation) error.value = errorMessage(cause)
    }
  }
  async function download(artifact: ArtifactView) {
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
  watch(
    session,
    () => {
      generation++
      controller.abort()
      controller = new AbortController()
      if (timer) clearTimeout(timer)
      runs.value = []
      artifacts.value = []
      error.value = ''
      closePreview()
      void reload()
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    generation++
    controller.abort()
    if (timer) clearTimeout(timer)
    closePreview()
  })
  return {
    runs,
    artifacts,
    error,
    previewUrl,
    previewName,
    previewType,
    preview,
    download,
    attachment,
    closePreview,
  }
}
