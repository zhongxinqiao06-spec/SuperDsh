import { useEffect, useState } from 'react'
import {
  OPEN_COMPATIBILITY_EVENT,
  openCompatibility,
  type ExtensionViewState,
} from './extensions.ts'
import './extension-view.css'

/** Browser compatibility uses an opener-free window; a same-origin iframe would expose the product DOM. */
export function ExtensionViewHost() {
  const [state, setState] = useState<ExtensionViewState>({ open: false })
  const native = window.superdshExtensions
  useEffect(() => {
    let live = true
    const sync = (): void => {
      void native
        ?.state()
        .then((value) => {
          if (live) setState(value)
        })
        .catch((error: unknown) => {
          if (live) setState({ open: false, error: String(error) })
        })
    }
    const open = (): void => {
      setState({ open: true })
    }
    const off = native?.subscribe(sync)
    if (native) sync()
    else window.addEventListener(OPEN_COMPATIBILITY_EVENT, open)
    return () => {
      live = false
      off?.()
      window.removeEventListener(OPEN_COMPATIBILITY_EVENT, open)
    }
  }, [native])
  const close = (): void => {
    if (native)
      void native
        .close()
        .catch((error: unknown) =>
          setState({ open: true, error: String(error) }),
        )
    else setState({ open: false })
  }
  if (!state.open && !state.error) return null
  return (
    <section
      className="superdshCompatibility"
      data-superdsh-compatibility-open={state.open}
      aria-label="插件兼容界面 / Plugin compatibility"
    >
      <header className="superdshCompatibilityToolbar">
        <strong>插件兼容界面 / Plugin compatibility</strong>
        {state.error && <span role="alert">{state.error}</span>}
        <button type="button" onClick={close}>
          关闭 / Close
        </button>
      </header>
      {!native && state.open && (
        <aside className="superdshCompatibilityNotice" role="status">
          <p>
            插件界面已在独立窗口打开 / Plugin compatibility opened in a separate
            window.
          </p>
          <button
            type="button"
            onClick={() => {
              void openCompatibility()
            }}
          >
            再次打开 / Open again
          </button>
        </aside>
      )}
    </section>
  )
}
