'use client'

import * as React from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { Button } from '@/components/ui/button'
import { useManagementText } from './controls'
import {
  createPdfPreviewDocument,
  pdfPreviewErrorCode,
  reportPdfPreviewError,
  waitForPdfTask,
  type PdfPreviewErrorCode,
  type PdfPreviewStage,
} from './agent-pdf-runtime'

type LoadedDocument = {
  source: string
  document: PDFDocumentProxy | null
  error: PdfPreviewErrorCode | null
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
  const [stage, setStage] = React.useState<PdfPreviewStage>('engine')
  const [width, setWidth] = React.useState(0)
  const viewport = React.useRef<HTMLDivElement>(null)
  const current = loaded?.source === contentBase64 ? loaded : null
  const document = current?.document ?? null

  React.useEffect(() => {
    let active = true
    const fail = (cause: unknown) => {
      if (!active) return
      reportPdfPreviewError('document', cause)
      setLoaded({
        source: contentBase64,
        document: null,
        error: pdfPreviewErrorCode(cause),
      })
    }
    setLoaded(null)
    setPage(1)
    setZoom(1)
    const task = createPdfPreviewDocument(
      contentBase64,
      (next) => active && setStage(next),
      fail,
    )
    void task.promise.then((document) => {
      if (active) setLoaded({ source: contentBase64, document, error: null })
    }, fail)
    return () => {
      active = false
      task.destroy()
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
            {stage === 'fallback'
              ? tr('正在切换备用预览…', 'Starting an alternative preview…')
              : stage === 'document'
                ? tr('正在读取文档内容…', 'Reading document contents…')
                : tr('正在加载文档预览…', 'Loading document preview…')}
          </p>
        )}
        {current?.error && (
          <div role="alert" className="space-y-3 py-8 text-center text-sm">
            <p>{previewErrorMessage(current.error, tr)}</p>
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
  const [error, setError] = React.useState<PdfPreviewErrorCode>('page')

  React.useEffect(() => {
    let active = true
    let task: RenderTask | undefined
    const controller = new AbortController()
    setStatus('loading')
    const render = async () => {
      try {
        const page = await waitForPdfTask(
          document.getPage(pageNumber),
          controller.signal,
          20_000,
          'page-timeout',
        )
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
        await waitForPdfTask(
          task.promise,
          controller.signal,
          20_000,
          'page-timeout',
        )
        if (active) setStatus('ready')
      } catch (cause) {
        task?.cancel()
        if (active) {
          reportPdfPreviewError('page', cause)
          setError(
            pdfPreviewErrorCode(cause) === 'page-timeout'
              ? 'page-timeout'
              : 'page',
          )
          setStatus('error')
        }
      }
    }
    void render()
    return () => {
      active = false
      controller.abort()
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
          <p>{previewErrorMessage(error, tr)}</p>
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

function previewErrorMessage(
  code: PdfPreviewErrorCode,
  tr: (zh: string, en: string) => string,
) {
  if (code === 'engine-timeout' || code === 'worker-timeout')
    return tr(
      '预览组件加载超时，请重试或下载原文件查看。',
      'The preview engine took too long to load. Retry or download the original file.',
    )
  if (code === 'engine' || code === 'worker')
    return tr(
      '预览组件未能启动，请重试或下载原文件查看。',
      'The preview engine could not start. Retry or download the original file.',
    )
  if (code === 'document-timeout')
    return tr(
      '读取文档超时，请重试或下载原文件查看。',
      'Reading this document timed out. Retry or download the original file.',
    )
  if (code === 'password')
    return tr(
      '此文档需要密码，请下载原文件后打开。',
      'This document requires a password. Download the original file to open it.',
    )
  if (code === 'page-timeout')
    return tr(
      '此页渲染超时，可重试或切换其他页面。',
      'This page took too long to render. Retry or switch to another page.',
    )
  if (code === 'page')
    return tr(
      '此页暂时无法显示，请重试或切换其他页面。',
      'This page could not be displayed. Retry or switch to another page.',
    )
  return tr(
    '无法读取文档预览，文件可能损坏，请重试或下载原文件查看。',
    'Could not read this document preview. It may be damaged. Retry or download the original file.',
  )
}
