import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PdfDocument,
  PdfSession,
} from '../sidebar-documentpreview/pdf/document.ts'
import { renderPdfPage } from '../sidebar-documentpreview/pdf/document.ts'

/** Product-owned renderer consumes authorized bytes, never a platform token URL. */
export function AgentPdfPreview({ contentBase64 }: { contentBase64: string }) {
  const [document, setDocument] = useState<PdfDocument | null>(null)
  const [page, setPage] = useState(1)
  const [rendered, setRendered] = useState<{
    document: PdfDocument
    page: number
  } | null>(null)
  const [error, setError] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)
  const rendering = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    const controller = new AbortController()
    let pdf: PdfSession | undefined
    setDocument(null)
    setError('')
    setPage(1)
    void (async () => {
      try {
        const { openPdf } =
          await import('../sidebar-documentpreview/pdf/runtime.ts')
        if (controller.signal.aborted) return
        const bytes = Uint8Array.from(atob(contentBase64), (character) =>
          character.charCodeAt(0),
        )
        pdf = openPdf(bytes, controller.signal, (cause) => {
          if (!controller.signal.aborted) setError(cause.message)
        })
        const next = await pdf.document
        if (!controller.signal.aborted) setDocument(next)
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      controller.abort()
      void pdf?.dispose()
    }
  }, [contentBase64])
  useEffect(() => {
    if (!document || !canvas.current) return
    const controller = new AbortController()
    const target = canvas.current
    const task = rendering.current
      .catch(() => undefined)
      .then(() =>
        renderPdfPage(
          document,
          page,
          target,
          controller.signal,
          window.devicePixelRatio || 1,
        ),
      )
    rendering.current = task
    void task.then(
      () => {
        if (!controller.signal.aborted) setRendered({ document, page })
      },
      (cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
    return () => controller.abort()
  }, [document, page])
  const ready = rendered?.document === document && rendered?.page === page
  return (
    <div className="productAgentPreview" aria-busy={!ready && !error}>
      {error && (
        <p role="alert" className="platformError">
          {error}
        </p>
      )}
      {!ready && !error && <p role="status">正在加载预览…</p>}
      {document && (
        <div className="platformActions">
          <Button
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            上一页
          </Button>
          <span>
            第 {page} / {document.numPages} 页
          </span>
          <Button
            size="sm"
            disabled={page >= document.numPages}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      <canvas
        ref={canvas}
        aria-label={`文档第 ${page} 页`}
        data-rendered-page={ready ? page : undefined}
      />
    </div>
  )
}
