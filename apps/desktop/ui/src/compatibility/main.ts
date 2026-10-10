import { createHarnessClientRuntime } from './harness/runtime.ts'
import './harness/web/base.css'
import './extension-view.css'

const container = document.getElementById('root')
if (!container)
  throw new Error('Compatibility document requires a root element')
if (new URLSearchParams(location.search).get('surface') === 'standalone') {
  const toolbar = document.createElement('header')
  toolbar.className = 'superdshCompatibilityToolbar'
  const title = document.createElement('strong')
  title.textContent = 'SuperDsh · 插件兼容界面 / Plugin compatibility'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '关闭 / Close'
  close.onclick = () => {
    window.close()
  }
  toolbar.append(title, close)
  document.body.prepend(toolbar)
  Object.assign(container.style, {
    position: 'absolute',
    top: '48px',
    bottom: '0',
    width: '100%',
    height: 'calc(100% - 48px)',
  })
}
container.textContent = '正在打开插件兼容界面… / Loading plugin compatibility…'
void createHarnessClientRuntime({ mode: 'compatibility' })
  .then((runtime) => {
    container.textContent = ''
    const unmount = runtime.ctx.uiRenderer.mount(container)
    window.addEventListener(
      'pagehide',
      () => {
        unmount()
        void runtime.dispose()
      },
      { once: true },
    )
  })
  .catch((error: unknown) => {
    container.textContent =
      error instanceof Error ? error.message : String(error)
  })
