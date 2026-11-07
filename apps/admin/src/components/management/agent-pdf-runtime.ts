import type { PDFDocumentLoadingTask, PDFWorker } from 'pdfjs-dist'

export type PdfPreviewErrorCode =
  | 'engine'
  | 'engine-timeout'
  | 'worker'
  | 'worker-timeout'
  | 'document'
  | 'document-timeout'
  | 'password'
  | 'page'
  | 'page-timeout'

export class PdfPreviewError extends Error {
  constructor(
    readonly code: PdfPreviewErrorCode,
    cause?: unknown,
  ) {
    super(`PDF preview failed: ${code}`, { cause })
    this.name = 'PdfPreviewError'
  }
}

export function pdfPreviewErrorCode(cause: unknown): PdfPreviewErrorCode {
  if (cause instanceof PdfPreviewError) return cause.code
  if (cause instanceof Error && cause.name === 'PasswordException')
    return 'password'
  return 'document'
}

export function reportPdfPreviewError(stage: string, cause: unknown) {
  const error =
    cause instanceof PdfPreviewError ? (cause.cause ?? cause) : cause
  // Never log source bytes, document names, account information or request URLs.
  console.warn('[document-preview]', {
    stage,
    code: pdfPreviewErrorCode(cause),
    cause: error instanceof Error ? error.name : typeof error,
    detail:
      error instanceof Error
        ? error.message
            .replace(/https?:\/\/\S+/g, '[resource URL]')
            .slice(0, 240)
        : 'Unknown rendering failure',
  })
}

/** Abort and timeout apply to imports and protocol requests, including silent workers. */
export function waitForPdfTask<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  code: PdfPreviewErrorCode,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      settle()
    }
    const abort = () => finish(() => reject(signal.reason))
    const timer = setTimeout(
      () => finish(() => reject(new PdfPreviewError(code))),
      timeoutMs,
    )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(
      (value) => finish(() => resolve(value)),
      (cause: unknown) => finish(() => reject(cause)),
    )
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export type PdfPreviewStage = 'engine' | 'worker' | 'fallback' | 'document'

export function createPdfPreviewDocument(
  contentBase64: string,
  onStage: (stage: PdfPreviewStage) => void,
  onRuntimeError: (error: PdfPreviewError) => void,
) {
  const controller = new AbortController()
  const { signal } = controller
  let nativeWorker: Worker | undefined
  let channel: MessageChannel | undefined
  let pdfWorker: PDFWorker | undefined
  let loadingTask: PDFDocumentLoadingTask | undefined
  let loaded = false
  let removeWorkerListeners: (() => void) | undefined

  const release = () => {
    const worker = nativeWorker
    const ports = channel
    const pdf = pdfWorker
    const task = loadingTask
    nativeWorker = undefined
    channel = undefined
    pdfWorker = undefined
    loadingTask = undefined
    removeWorkerListeners?.()
    removeWorkerListeners = undefined
    const terminate = () => {
      pdf?.destroy()
      worker?.terminate()
      ports?.port1.close()
      ports?.port2.close()
    }
    if (!task) return terminate()
    // A nonresponding worker cannot acknowledge PDF.js destruction.
    const timer = setTimeout(terminate, 1000)
    void task
      .destroy()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        terminate()
      })
  }
  const destroy = () => {
    if (signal.aborted) return
    controller.abort(new DOMException('Preview closed', 'AbortError'))
    release()
  }

  const promise = (async () => {
    try {
      onStage('engine')
      const pdfjs = await waitForPdfTask(
        import('pdfjs-dist/legacy/build/pdf.mjs').catch((cause: unknown) => {
          throw new PdfPreviewError('engine', cause)
        }),
        signal,
        15_000,
        'engine-timeout',
      )
      signal.throwIfAborted()
      let nativeFailure: Promise<never> | undefined
      try {
        onStage('worker')
        nativeWorker = new Worker(
          new URL(
            'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
            import.meta.url,
          ),
          { type: 'module', name: 'agent-document-preview' },
        )
        const ready = deferred<void>()
        const failed = deferred<never>()
        nativeFailure = failed.promise
        void nativeFailure.catch(() => undefined)
        const worker = nativeWorker
        const receive = (event: MessageEvent) => {
          if (
            event.data?.sourceName === 'worker' &&
            event.data?.targetName === 'main' &&
            event.data?.action === 'ready'
          )
            ready.resolve()
        }
        const fail = () => {
          const error = new PdfPreviewError('worker')
          failed.reject(error)
          if (loaded && !signal.aborted) {
            onRuntimeError(error)
            destroy()
          }
        }
        worker.addEventListener('message', receive)
        worker.addEventListener('error', fail)
        worker.addEventListener('messageerror', fail)
        removeWorkerListeners = () => {
          worker.removeEventListener('message', receive)
          worker.removeEventListener('error', fail)
          worker.removeEventListener('messageerror', fail)
        }
        await waitForPdfTask(
          Promise.race([ready.promise, nativeFailure]),
          signal,
          8000,
          'worker-timeout',
        )
        signal.throwIfAborted()
        pdfWorker = pdfjs.PDFWorker.create({ port: worker })
      } catch (cause) {
        if (signal.aborted) throw cause
        reportPdfPreviewError('native-worker', cause)
        release()
        nativeFailure = undefined
        onStage('fallback')
        try {
          const fallback = await waitForPdfTask(
            import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
            signal,
            15_000,
            'engine-timeout',
          )
          signal.throwIfAborted()
          // Independent ports keep each preview's protocol and cleanup local.
          // Avoid GlobalWorkerOptions and PDF.js's global worker-disable flag.
          channel = new MessageChannel()
          const port = Object.assign(channel.port1, {
            onmessage: null as Worker['onmessage'],
            onmessageerror: null as Worker['onmessageerror'],
            onerror: null as Worker['onerror'],
            terminate: () => channel?.port1.close(),
          })
          fallback.WorkerMessageHandler.initializeFromPort(channel.port2)
          pdfWorker = pdfjs.PDFWorker.create({ port })
          channel.port1.start()
          channel.port2.start()
        } catch (cause) {
          if (cause instanceof PdfPreviewError) throw cause
          throw new PdfPreviewError('engine', cause)
        }
      }
      signal.throwIfAborted()
      onStage('document')
      loadingTask = pdfjs.getDocument({
        data: Uint8Array.from(atob(contentBase64), (value) =>
          value.charCodeAt(0),
        ),
        worker: pdfWorker,
        useWasm: false,
        useSystemFonts: true,
      })
      const document = await waitForPdfTask(
        nativeFailure
          ? Promise.race([loadingTask.promise, nativeFailure])
          : loadingTask.promise,
        signal,
        30_000,
        'document-timeout',
      )
      signal.throwIfAborted()
      loaded = true
      return document
    } catch (cause) {
      release()
      throw cause
    }
  })()

  return { promise, destroy }
}
