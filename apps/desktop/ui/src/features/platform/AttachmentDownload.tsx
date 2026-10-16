import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlatformJson } from '@superdsh/core/contracts/platform'
import { object, string, type Row } from './platform-model.ts'

/** The URL is a local Blob; all remote authorization and fetching stays in Core. */
export function AttachmentDownload({
  file,
  disabled,
  download,
  run,
}: {
  file: Row
  disabled: boolean
  download(fileId: string): Promise<PlatformJson>
  run(task: () => Promise<void>): Promise<void>
}) {
  return (
    <Button
      size="sm"
      disabled={disabled || !string(file.fileId)}
      onClick={() => {
        void run(async () => {
          const value = object(await download(string(file.fileId)))
          const bytes = Uint8Array.from(
            atob(string(value.contentBase64)),
            (character) => character.charCodeAt(0),
          )
          const url = URL.createObjectURL(
            new Blob([bytes], {
              type: string(value.mediaType) || 'application/octet-stream',
            }),
          )
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = string(file.name).split(/[\\/]/).at(-1) || '附件'
          document.body.append(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        })
      }}
    >
      下载 {string(file.name) || '附件'}
    </Button>
  )
}
