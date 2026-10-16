'use client'

import * as React from 'react'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFWorker,
  RenderTask,
} from 'pdfjs-dist'
import { Button } from '@/components/ui/button'
import { useManagementText } from './controls'

type LoadedDocument = {
  source: string
  document: PDFDocumentProxy | null
  failed: boolean
}

export function AgentPdfPreview({
  contentBase64,
  name,
}: {
  contentBase64: string
  name: string
}) {
  const tr = useManagementText()
  const [loaded, setLoaded] = React.useState<LoadedDocument | null>(null)
  const [page, setPage] = React.useState(1)
  const [zoom, setZoom] = React.useState(1)
  const [attempt, setAttempt] = React.useState(0)
  const [width, setWidth] = React.useState(0)
  const viewport = React.useRef<HTMLDivElement>(null)
  const current = loaded?.source === contentBase64 ? loaded : null
  const document = current?.document ?? null

  React.useEffect(() => {
    let active = true
    let disposed = false
    let nativeWorker: Worker | undefined
    let pdfWorker: PDFWorker | undefined
    let loadingTask: PDFDocumentLoadingTask | undefined
    const dispose = () => {
      if (disposed) return
      disposed = true
      const terminate = () => {
        pdfWorker?.destroy()
        nativeWorker?.terminate()
      }
      if (!loadingTask) {
        terminate()
        return
      }
      // Let PDF.js release page/font resources before ending its owned worker.
      // A failed worker cannot acknowledge destruction, so bound that wait.
      const timeout = window.setTimeout(terminate, 1000)
      void loadingTask
        .destroy()
        .catch(() => undefined)
        .finally(() => {
          window.clearTimeout(timeout)
          terminate()
        })
    }
    const fail = () => {
      if (active)
        setLoaded({ source: contentBase64, document: null, failed: true })
      dispose()
    }
    setLoaded(null)
    setPage(1)
    setZoom(1)
    const load = async () => {
      try {
        // PDF.js needs browser globals; keep it out of server rendering.
        const pdfjs = await import('pdfjs-dist')
        if (!active) return
        const data = Uint8Array.from(atob(contentBase64), (value) =>
          value.charCodeAt(0),
        )
        nativeWorker = new Worker(
          new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
          { type: 'module', name: 'agent-document-preview' },
        )
        nativeWorker.addEventListener('error', fail, { once: true })
        nativeWorker.addEventListener('messageerror', fail, { once: true })
        pdfWorker = pdfjs.PDFWorker.create({ port: nativeWorker })
        loadingTask = pdfjs.getDocument({
          data,
          worker: pdfWorker,
          useWasm: false,
          useSystemFonts: true,
        })
        const next = await loadingTask.promise
        if (active && !disposed)
          setLoaded({ source: contentBase64, document: next, failed: false })
      } catch {
        fail()
      }
    }
    void load()
    return () => {
      active = false
      dispose()
    }
  }, [contentBase64, attempt])

  React.useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setWidth(Math.max(0, element.clientWidth - 32))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0
  }, [page, contentBase64])

  return (
    <div className="space-y-3" aria-label={tr('文档预览', 'Document preview')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!document || page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            {tr('上一页', 'Previous page')}
          </Button>
          <span
            className="min-w-16 text-center text-sm tabular-nums"
            aria-live="polite"
          >
            {document ? `${page} / ${document.numPages}` : '— / —'}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!document || page >= document.numPages}
            onClick={() =>
              setPage((value) => Math.min(document?.numPages ?? 1, value + 1))
            }
          >
            {tr('下一页', 'Next page')}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!document || zoom <= 0.5}
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
            aria-label={tr('缩小', 'Zoom out')}
          >
            −
          </Button>
          <span className="min-w-12 text-center text-xs tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!document || zoom >= 2}
            onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
            aria-label={tr('放大', 'Zoom in')}
          >
            +
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!document || zoom === 1}
            onClick={() => setZoom(1)}
          >
            {tr('适应宽度', 'Fit width')}
          </Button>
        </div>
      </div>
      <div
        ref={viewport}
        tabIndex={0}
        aria-label={tr('文档页面', 'Document pages')}
        className="max-h-[55svh] min-h-64 overflow-auto rounded-lg border bg-muted/40 p-4"
      >
        {!current && (
          <p
            role="status"
            className="py-8 text-center text-sm text-muted-foreground"
          >
            {tr('正在加载文档预览…', 'Loading document preview…')}
          </p>
        )}
        {current?.failed && (
          <div role="alert" className="space-y-3 py-8 text-center text-sm">
            <p>
              {tr(
                '文档预览加载失败，请重试。',
                'Could not load this document preview. Please retry.',
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {tr('重试', 'Retry')}
            </Button>
          </div>
        )}
        {document && width > 0 && (
          <PdfPage
            key={`${page}:${width}:${zoom}`}
            document={document}
            name={name}
            pageNumber={page}
            width={width * zoom}
          />
        )}
      </div>
    </div>
  )
}

function PdfPage({
  document,
  name,
  pageNumber,
  width,
}: {
  document: PDFDocumentProxy
  name: string
  pageNumber: number
  width: number
}) {
  const tr = useManagementText()
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    let active = true
    let task: RenderTask | undefined
    setStatus('loading')
    const render = async () => {
      try {
        const page = await document.getPage(pageNumber)
        const element = canvas.current
        if (!active || !element) return
        const original = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: width / original.width })
        // Bound backing-store memory on high DPI displays and oversized pages.
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
        )
        element.width = Math.max(1, Math.ceil(viewport.width * ratio))
        element.height = Math.max(1, Math.ceil(viewport.height * ratio))
        element.style.width = `${viewport.width}px`
        element.style.height = `${viewport.height}px`
        task = page.render({
          canvas: element,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        })
        await task.promise
        if (active) setStatus('ready')
      } catch {
        if (active) setStatus('error')
      }
    }
    void render()
    return () => {
      active = false
      task?.cancel()
    }
  }, [document, pageNumber, width, attempt])

  return (
    <div aria-busy={status === 'loading'}>
      {status === 'loading' && (
        <p
          role="status"
          className="py-8 text-center text-sm text-muted-foreground"
        >
          {tr('正在渲染页面…', 'Rendering page…')}
        </p>
      )}
      {status === 'error' && (
        <div role="alert" className="space-y-3 py-8 text-center text-sm">
          <p>{tr('此页暂时无法显示。', 'This page could not be displayed.')}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}
      <canvas
        ref={canvas}
        role="img"
        aria-label={tr(
          `${name}，第 ${pageNumber} 页`,
          `${name}, page ${pageNumber}`,
        )}
        className="mx-auto bg-white shadow-sm"
        hidden={status !== 'ready'}
      />
    </div>
  )
}
