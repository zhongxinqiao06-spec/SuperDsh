import { Component, useEffect, useState, type ReactNode } from 'react'
import {
  createHarnessClientRuntime,
  type HarnessClientRuntime,
} from '../compatibility/harness/runtime.ts'
import { ExtensionViewHost } from '../compatibility/ExtensionViewHost.tsx'
import type {} from '../compatibility/harness/renderer/index.ts'
import './product.css'
import { ProductWorkspace } from '../features/platform/ProductWorkspace.tsx'

type BootState =
  | { phase: 'starting' }
  | { phase: 'ready'; runtime: HarnessClientRuntime }
  | { phase: 'failed'; message: string }
export class ProductErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null }
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  render(): ReactNode {
    return this.state.error ? (
      <ProductFailure message={this.state.error} />
    ) : (
      this.props.children
    )
  }
}
function ProductFailure({ message }: { message: string }) {
  return (
    <main className="superdshBoot" role="alert">
      <h1>SuperDsh</h1>
      <p>{message}</p>
      <button type="button" onClick={() => location.reload()}>
        重新加载 / Reload
      </button>
    </main>
  )
}
/** The product owns the document root even while its required engine is unavailable. */
export function ProductApp() {
  const [state, setState] = useState<BootState>({ phase: 'starting' })
  useEffect(() => {
    let disposed = false,
      runtime: HarnessClientRuntime | undefined
    void createHarnessClientRuntime({ mode: 'product' })
      .then((value) => {
        runtime = value
        if (disposed) {
          void value.dispose()
          return
        }
        setState({ phase: 'ready', runtime: value })
      })
      .catch((error: unknown) => {
        if (disposed) return
        const message = error instanceof Error ? error.message : String(error)
        setState({ phase: 'failed', message })
        const bridge = (
          globalThis as {
            dshDesktopBoot?: { failed(message: string): Promise<void> }
          }
        ).dshDesktopBoot
        void bridge?.failed(message).catch(console.error)
      })
    return () => {
      disposed = true
      void runtime?.dispose()
    }
  }, [])
  return (
    <>
      <div
        data-superdsh-product-root
        data-superdsh-shell
        data-superdsh-phase={state.phase}
        style={{ display: 'contents' }}
      >
        {state.phase === 'starting' ? (
          <main className="superdshBoot" role="status">
            <h1>SuperDsh</h1>
            <p>正在启动… / Starting…</p>
          </main>
        ) : state.phase === 'failed' ? (
          <ProductFailure message={state.message} />
        ) : (
          state.runtime.ctx.uiRenderer.renderProduct()
        )}
      </div>
      <ExtensionViewHost />
      {state.phase === 'ready' && <ProductWorkspace />}
    </>
  )
}
