import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://fixture.example/#/agents',
  pretendToBeVisual: true,
})
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'Element',
  'DocumentFragment',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act, StrictMode } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const sourceHooks = registerSource()
const previewHooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/agent-pdf-preview.tsx'))
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { createElement } from 'react'
          export function AgentPdfPreview({ name, contentBase64 }) {
            return createElement('output', {
              'data-pdf-preview': name,
            }, contentBase64)
          }
        `,
      }
    return nextLoad(url, context)
  },
})
const { AgentAssetsPanel } =
  await import('../src/components/management/agent-assets-panel.tsx')
const { AgentAssetPreview } =
  await import('../src/components/management/agent-asset-preview.tsx')
const { agentsApi } = await import('../src/features/agents/api.ts')
const { saveStoredSession, clearStoredSession } =
  await import('../src/features/auth/session.ts')

test.after(() => {
  previewHooks.deregister()
  sourceHooks.deregister()
  dom.window.close()
})

const account = (userId) => ({
  userId,
  role: 'admin',
  roles: ['admin'],
  permissions: ['agents.manage'],
  authzVersion: 1,
  accessToken: `fixture-${userId}`,
})
const presentation = {
  id: 'sales-slides',
  name: '销售汇报模板.PPTX',
  kind: 'presentation-template',
  size: 120,
  preview: '',
  sha256: 'slides-hash',
  createdAt: '2026-10-15T10:00:00Z',
}
const documentAsset = {
  ...presentation,
  id: 'sales-document',
  name: '销售报告.docx',
  kind: 'knowledge',
  preview: 'Extracted text without document layout',
  sha256: 'document-hash',
}
const pdf = (asset, contentBase64 = `pdf-${asset.id}`) => ({
  name: asset.name.replace(/\.[^.]+$/, '.pdf'),
  mediaType: 'application/pdf',
  contentBase64,
})
const deferred = () => {
  let resolve
  const promise = new Promise((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
const preview = () => document.querySelector('[data-pdf-preview]')
const dialog = () => document.querySelector('[role="dialog"]')
async function click(label, scope = document) {
  const button = [...scope.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  )
  assert.ok(button, `button ${label}`)
  await act(async () => button.click())
}
async function render(t, Component, props, strict = false) {
  saveStoredSession(account('account-a'))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let closed = false
  const update = async (nextProps) => {
    const content = h(
      NextIntlClientProvider,
      { locale: 'en', messages: {}, timeZone: 'UTC' },
      h(Component, nextProps),
    )
    await act(async () =>
      root.render(strict ? h(StrictMode, null, content) : content),
    )
  }
  const close = async () => {
    if (closed) return
    closed = true
    await act(async () => root.unmount())
    container.remove()
    clearStoredSession()
  }
  t.after(close)
  await update(props)
  return { container, update, close }
}

test('PPTX and DOCX request a visual preview only when View is clicked', async (t) => {
  const requests = []
  t.mock.method(agentsApi, 'previewAsset', async (id, signal) => {
    requests.push({ id, signal })
    return pdf(id === presentation.id ? presentation : documentAsset)
  })
  t.mock.method(agentsApi, 'downloadAsset', () =>
    assert.fail('View must not download the original file'),
  )
  const view = await render(t, AgentAssetsPanel, {
    assets: [presentation, documentAsset],
    onUploaded() {},
  })
  assert.equal(requests.length, 0)
  assert.equal(preview(), null)

  for (const asset of [presentation, documentAsset]) {
    const row = [...view.container.querySelectorAll('tbody tr')].find((item) =>
      item.textContent.includes(asset.name),
    )
    await click('View', row)
    assert.equal(requests.at(-1).id, asset.id)
    assert.ok(requests.at(-1).signal instanceof AbortSignal)
    assert.equal(preview()?.textContent, pdf(asset).contentBase64)
    assert.doesNotMatch(dialog().textContent, /no text preview|Extracted text/)
    await click('Close', dialog())
    assert.equal(preview(), null)
  }
  assert.equal(requests.length, 2)
})

test('text resources keep their text preview without requesting a PDF', async (t) => {
  t.mock.method(agentsApi, 'previewAsset', () =>
    assert.fail('text resources already have a preview'),
  )
  const textAsset = {
    ...documentAsset,
    id: 'sales-csv',
    name: '销售数据.csv',
    preview: '季度,销售额\n第一季度,100',
  }
  await render(t, AgentAssetsPanel, {
    assets: [textAsset],
    onUploaded() {},
  })
  await click('View')
  assert.ok(dialog().textContent.includes(textAsset.preview))
  assert.equal(preview(), null)
})

test('StrictMode effect replay starts only one Office conversion request', async (t) => {
  const requests = []
  t.mock.method(agentsApi, 'previewAsset', async (id, signal) => {
    requests.push({ id, signal })
    return pdf(presentation)
  })
  const view = await render(t, AgentAssetPreview, { asset: presentation }, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].signal.aborted, false)
  assert.equal(preview()?.textContent, pdf(presentation).contentBase64)
  await view.close()
  assert.equal(requests[0].signal.aborted, true)
})

test('failed preview requests show the error and retry only on user action', async (t) => {
  let attempts = 0
  t.mock.method(agentsApi, 'previewAsset', async () => {
    if (++attempts === 1) throw new Error('Preview service unavailable')
    return pdf(presentation)
  })
  const view = await render(t, AgentAssetPreview, { asset: presentation })
  assert.equal(attempts, 1)
  assert.match(view.container.textContent, /Preview service unavailable/)
  assert.equal(preview(), null)
  await click('Retry', view.container)
  assert.equal(attempts, 2)
  assert.equal(preview()?.textContent, pdf(presentation).contentBase64)
  assert.doesNotMatch(view.container.textContent, /Preview service unavailable/)
})

test('invalid preview content is rejected before reaching the PDF renderer', async (t) => {
  const responses = [
    { ...pdf(presentation), mediaType: 'text/html' },
    pdf(presentation, ''),
  ]
  t.mock.method(agentsApi, 'previewAsset', async () => responses.shift())
  const view = await render(t, AgentAssetPreview, { asset: presentation })
  assert.match(view.container.textContent, /Invalid document preview/)
  assert.equal(preview(), null)
  await click('Retry', view.container)
  assert.match(view.container.textContent, /Invalid document preview/)
  assert.equal(preview(), null)
})

test('closing and reopening the dialog aborts the old request and ignores its late result', async (t) => {
  const oldRequest = deferred()
  const newRequest = deferred()
  const requests = []
  t.mock.method(agentsApi, 'previewAsset', (id, signal) => {
    requests.push({ id, signal })
    return requests.length === 1 ? oldRequest.promise : newRequest.promise
  })
  await render(t, AgentAssetsPanel, {
    assets: [presentation],
    onUploaded() {},
  })
  await click('View')
  assert.equal(requests.length, 1)
  await click('Close', dialog())
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(dialog(), null)
  await click('View')
  assert.equal(requests.length, 2)
  await act(async () => oldRequest.resolve(pdf(presentation, 'old-preview')))
  assert.equal(preview(), null)
  await act(async () => newRequest.resolve(pdf(presentation, 'new-preview')))
  assert.equal(preview()?.textContent, 'new-preview')
})

test('switching files clears the displayed PDF and fences late responses', async (t) => {
  const secondRequest = deferred()
  const thirdRequest = deferred()
  const requests = []
  t.mock.method(agentsApi, 'previewAsset', (id, signal) => {
    requests.push({ id, signal })
    if (requests.length === 1) return Promise.resolve(pdf(presentation))
    return requests.length === 2 ? secondRequest.promise : thirdRequest.promise
  })
  const view = await render(t, AgentAssetPreview, { asset: presentation })
  assert.equal(preview()?.textContent, pdf(presentation).contentBase64)
  await view.update({ asset: documentAsset })
  assert.equal(preview(), null)
  await view.update({ asset: { ...presentation, sha256: 'updated-slides' } })
  assert.equal(requests[1].signal.aborted, true)
  await act(async () => secondRequest.resolve(pdf(documentAsset)))
  assert.equal(preview(), null)
  await act(async () => thirdRequest.resolve(pdf(presentation, 'updated-pdf')))
  assert.equal(preview()?.textContent, 'updated-pdf')
})

test('signing out removes a visible preview and does not reload it anonymously', async (t) => {
  const requests = []
  t.mock.method(agentsApi, 'previewAsset', async (id, signal) => {
    requests.push({ id, signal })
    return pdf(presentation)
  })
  await render(t, AgentAssetPreview, { asset: presentation })
  assert.ok(preview())
  await act(async () => clearStoredSession())
  assert.equal(preview(), null)
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(requests.length, 1)
})

test('a response from the previous account cannot appear after identity changes', async (t) => {
  const oldRequest = deferred()
  const newRequest = deferred()
  const requests = []
  t.mock.method(agentsApi, 'previewAsset', (id, signal) => {
    requests.push({ id, signal })
    return requests.length === 1 ? oldRequest.promise : newRequest.promise
  })
  await render(t, AgentAssetPreview, { asset: presentation })
  await act(async () => saveStoredSession(account('account-b')))
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(requests.length, 2)
  await act(async () => oldRequest.resolve(pdf(presentation, 'account-a-pdf')))
  assert.equal(preview(), null)
  await act(async () => newRequest.resolve(pdf(presentation, 'account-b-pdf')))
  assert.equal(preview()?.textContent, 'account-b-pdf')
})

test('token rotation retains the preview while changed authorization reloads it', async (t) => {
  const updatedRequest = deferred()
  const requests = []
  t.mock.method(agentsApi, 'previewAsset', (id, signal) => {
    requests.push({ id, signal })
    return requests.length === 1
      ? Promise.resolve(pdf(presentation))
      : updatedRequest.promise
  })
  await render(t, AgentAssetPreview, { asset: presentation })
  await act(async () =>
    saveStoredSession({
      ...account('account-a'),
      accessToken: 'rotated-token',
    }),
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].signal.aborted, false)
  assert.equal(preview()?.textContent, pdf(presentation).contentBase64)
  await act(async () =>
    saveStoredSession({ ...account('account-a'), authzVersion: 2 }),
  )
  assert.equal(requests.length, 2)
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(preview(), null)
  await act(async () =>
    updatedRequest.resolve(pdf(presentation, 'reauthorized')),
  )
  assert.equal(preview()?.textContent, 'reauthorized')
})
