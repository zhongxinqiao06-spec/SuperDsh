import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://preview.example/',
})
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(window, 'devicePixelRatio', { value: 2 })
let availableWidth = 832
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  get: () => availableWidth,
})
const observers = new Set()
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback
    observers.add(this)
  }
  observe() {}
  disconnect() {
    observers.delete(this)
  }
}
globalThis.Worker = class extends EventTarget {
  constructor(url, options) {
    super()
    this.url = url
    this.options = options
    this.terminated = false
    globalThis.agentPdfFixture.workers.push(this)
  }
  terminate() {
    this.terminated = true
  }
}
const sourceHooks = registerSource()
const mockHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'pdfjs-dist') {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          'export const getDocument=(options)=>globalThis.agentPdfFixture.getDocument(options); export const PDFWorker={create:(options)=>globalThis.agentPdfFixture.createWorker(options)}',
        )}`,
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const { AgentPdfPreview } =
  await import('../src/components/management/agent-pdf-preview.tsx')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function fixture(t) {
  availableWidth = 832
  const state = {
    workers: [],
    pdfWorkers: [],
    loads: [],
    renders: [],
    getPage: null,
    renderPage: null,
    loadDocument: null,
    createWorker(options) {
      const worker = {
        ...options,
        destroyed: false,
        destroy() {
          this.destroyed = true
        },
      }
      this.pdfWorkers.push(worker)
      return worker
    },
    getDocument(options) {
      const name = new TextDecoder().decode(options.data)
      const document = {
        numPages: 3,
        getPage: async (page) => {
          if (state.getPage) return state.getPage(name, page)
          return {
            getViewport: ({ scale }) => ({
              width: 600 * scale,
              height: 450 * scale,
            }),
            render: (parameters) => {
              const task = {
                name,
                page,
                ...parameters,
                cancelled: false,
                promise: state.renderPage
                  ? state.renderPage(name, page)
                  : Promise.resolve(),
                cancel() {
                  this.cancelled = true
                },
              }
              state.renders.push(task)
              return task
            },
          }
        },
      }
      const task = {
        options,
        destroyed: false,
        promise: state.loadDocument
          ? state.loadDocument(document)
          : Promise.resolve(document),
        async destroy() {
          this.destroyed = true
        },
      }
      this.loads.push(task)
      return task
    },
  }
  globalThis.agentPdfFixture = state
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let unmounted = false
  const unmount = async () => {
    if (unmounted) return
    unmounted = true
    await act(async () => root.unmount())
    host.remove()
  }
  t.after(unmount)
  return {
    state,
    host,
    unmount,
    async render(name = 'first') {
      await act(async () =>
        root.render(
          h(
            NextIntlClientProvider,
            { locale: 'en', messages: {} },
            h(AgentPdfPreview, {
              contentBase64: btoa(name),
              name: `${name}.pptx`,
            }),
          ),
        ),
      )
    },
    button(name) {
      const found = [...host.querySelectorAll('button')].find(
        (element) =>
          (element.getAttribute('aria-label') ?? element.textContent) === name,
      )
      assert.ok(found, `Missing ${name} button`)
      return found
    },
    async click(name) {
      await act(async () => this.button(name).click())
    },
  }
}

test('PDF preview renders pages with responsive fit, bounded zoom and navigation', async (t) => {
  const f = await fixture(t)
  await f.render()
  assert.equal(f.state.workers.length, 1)
  assert.match(
    f.state.workers[0].url.href,
    /pdfjs-dist\/build\/pdf\.worker\.min\.mjs$/,
  )
  assert.equal(f.state.workers[0].options.type, 'module')
  assert.equal(f.state.loads[0].options.worker.port, f.state.workers[0])
  assert.equal(f.state.loads[0].options.useWasm, false)
  assert.equal(f.host.querySelector('canvas').hidden, false)
  assert.equal(f.state.renders[0].canvas.width, 1600)
  assert.equal(f.state.renders[0].viewport.width, 800)
  assert.match(f.host.textContent, /1 \/ 3/)
  assert.equal(f.button('Previous page').disabled, true)
  await f.click('Next page')
  assert.equal(f.state.renders.at(-1).page, 2)
  await f.click('Next page')
  assert.equal(f.button('Next page').disabled, true)
  await f.click('Previous page')
  await f.click('Zoom in')
  assert.equal(f.state.renders.at(-1).viewport.width, 1000)
  await f.click('Fit width')
  assert.equal(f.state.renders.at(-1).viewport.width, 800)
  availableWidth = 432
  await act(async () => {
    for (const observer of observers) observer.callback()
  })
  assert.equal(f.state.renders.at(-1).viewport.width, 400)
  assert.equal(
    f.host.querySelector('canvas').getAttribute('aria-label'),
    'first.pptx, page 2',
  )
  await f.unmount()
  assert.equal(f.state.loads[0].destroyed, true)
  assert.equal(f.state.pdfWorkers[0].destroyed, true)
  assert.equal(f.state.workers[0].terminated, true)
  assert.equal(observers.size, 0)
})

test('switching documents cancels old renders and resets page and zoom without stale completion', async (t) => {
  const f = await fixture(t)
  await f.render()
  await f.click('Next page')
  await f.click('Zoom in')
  const pending = deferred()
  f.state.renderPage = (name) =>
    name === 'first' ? pending.promise : Promise.resolve()
  await f.click('Next page')
  const stale = f.state.renders.at(-1)
  assert.match(f.host.textContent, /Rendering page/)
  await f.render('second')
  assert.equal(stale.cancelled, true)
  assert.equal(f.state.loads[0].destroyed, true)
  assert.equal(f.state.workers[0].terminated, true)
  assert.match(f.host.textContent, /1 \/ 3/)
  assert.equal(f.state.renders.at(-1).viewport.width, 800)
  assert.equal(f.state.renders.at(-1).name, 'second')
  await act(async () => pending.resolve())
  assert.equal(
    f.host.querySelector('canvas').getAttribute('aria-label'),
    'second.pptx, page 1',
  )
  assert.equal(f.host.querySelector('[role="alert"]'), null)
})

test('unmounting during page lookup does not start another render', async (t) => {
  const f = await fixture(t)
  const pending = deferred()
  f.state.getPage = () => pending.promise
  await f.render()
  await f.unmount()
  await act(async () =>
    pending.resolve({
      render() {
        throw Error('stale page rendered')
      },
    }),
  )
  assert.equal(f.state.renders.length, 0)
  assert.equal(f.state.workers[0].terminated, true)
})

test('load errors and worker failures display a retry that starts a fresh worker', async (t) => {
  const f = await fixture(t)
  f.state.loadDocument = () => Promise.reject(Error('corrupt PDF'))
  await f.render()
  assert.match(
    f.host.querySelector('[role="alert"]').textContent,
    /Could not load/,
  )
  assert.equal(f.state.workers[0].terminated, true)
  f.state.loadDocument = null
  await f.click('Retry')
  assert.equal(f.host.querySelector('canvas').hidden, false)
  await act(async () =>
    f.state.workers.at(-1).dispatchEvent(new Event('error')),
  )
  assert.match(
    f.host.querySelector('[role="alert"]').textContent,
    /Could not load/,
  )
  await f.click('Retry')
  assert.equal(f.state.workers.length, 3)
  assert.equal(f.host.querySelector('canvas').hidden, false)
})

test('page errors offer a retry without reloading the document', async (t) => {
  const f = await fixture(t)
  f.state.renderPage = () => Promise.reject(Error('page render failed'))
  await f.render()
  assert.match(
    f.host.querySelector('[role="alert"]').textContent,
    /could not be displayed/,
  )
  assert.equal(f.host.querySelector('canvas').hidden, true)
  f.state.renderPage = null
  await f.click('Retry')
  assert.equal(f.host.querySelector('canvas').hidden, false)
  assert.equal(f.state.loads.length, 1)
})

test.after(() => {
  mockHooks.deregister()
  sourceHooks.deregister()
  dom.window.close()
  delete globalThis.agentPdfFixture
})
