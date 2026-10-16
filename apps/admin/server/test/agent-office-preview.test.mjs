import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { ApiError, ApiRouter } from '../http/api-router.ts'
import { requirePermission } from '../conversations/store.ts'
import { OfficeAssetPreviewRenderer } from '../agents/office/preview.ts'
import { BusinessAgentService } from '../agents/service.ts'
import { registerBusinessAgentRoutes } from '../agents/routes.ts'

const pdf = Buffer.from('%PDF-1.7\nsynthetic preview content\n%%EOF\n')
async function officeFile(extension = 'docx', extraEntries = {}) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file(
    extension === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml',
    '<document/>',
  )
  for (const [name, content] of Object.entries(extraEntries))
    zip.file(name, content)
  return {
    filename: `销售资料.${extension}`,
    content: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }),
  }
}

test('Office preview converts both supported originals to bounded PDFs and removes private scratch files', async () => {
  for (const extension of ['docx', 'pptx']) {
    const file = await officeFile(extension)
    const original = Buffer.from(file.content)
    let request,
      options,
      disposed = false
    const renderer = new OfficeAssetPreviewRenderer({
      createConverter: async (configuration) => {
        options = configuration
        return {
          async render(input, signal) {
            request = input
            assert.equal(signal.aborted, false)
            assert.equal(
              dirname(dirname(resolve(input.inputPath))),
              resolve(tmpdir()),
            )
            assert.match(input.inputPath, new RegExp(`source\\.${extension}$`))
            assert.deepEqual(await readFile(input.inputPath), original)
            await writeFile(input.outputPath, pdf, { flag: 'wx' })
            return { backend: 'native', missingFonts: ['Fixture font'] }
          },
          async dispose() {
            disposed = true
          },
        }
      },
    })
    const result = await renderer.render(file)
    assert.deepEqual(result, {
      name: '销售资料.pdf',
      mediaType: 'application/pdf',
      contentBase64: pdf.toString('base64'),
      missingFonts: ['Fixture font'],
    })
    assert.deepEqual(file.content, original)
    assert.equal(disposed, true)
    assert.equal(options.timeoutMs, 60_000)
    assert.equal(options.maxOutputBytes, 16 * 1024 * 1024)
    assert.equal(options.maxArchiveEntries, 600)
    await assert.rejects(stat(dirname(request.inputPath)), { code: 'ENOENT' })
  }
})

test('Office preview revalidates stored archives before creating a converter', async () => {
  let calls = 0
  const renderer = new OfficeAssetPreviewRenderer({
    createConverter: async () => {
      calls++
      throw new Error('must not convert')
    },
  })
  const ordinary = await officeFile()
  for (const file of [
    { ...ordinary, filename: '../private.docx' },
    { ...ordinary, filename: 'not-office.txt' },
    { ...ordinary, filename: 'wrong-format.pptx' },
    { filename: 'broken.docx', content: Buffer.from('invalid') },
    await officeFile('docx', {
      'word/_rels/document.xml.rels':
        '<Relationships><Relationship TargetMode="External" Target="https://example.invalid/private"/></Relationships>',
    }),
    await officeFile('docx', { 'word/embeddings/unsafe.bin': 'unsafe' }),
    await officeFile('docx', {
      'word/document.xml': '<!DOCTYPE document><document/>',
    }),
  ])
    await assert.rejects(renderer.render(file), { status: 422 })
  assert.equal(calls, 0)
})

test('Office preview admits one conversion at a time and releases admission after cleanup', async () => {
  const file = await officeFile()
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  let calls = 0,
    disposed = 0
  const renderer = new OfficeAssetPreviewRenderer({
    createConverter: async () => {
      calls++
      return {
        async render(input) {
          started.resolve()
          await finish.promise
          await writeFile(input.outputPath, pdf)
          return { backend: 'native', missingFonts: [] }
        },
        async dispose() {
          disposed++
        },
      }
    },
  })
  const first = renderer.render(file)
  await started.promise
  await assert.rejects(renderer.render(file), {
    status: 503,
    code: 'office_preview_busy',
  })
  assert.equal(calls, 1)
  finish.resolve()
  await first
  await renderer.render(file)
  assert.equal(calls, 2)
  assert.equal(disposed, 2)
})

test('Office preview reports timeout, conversion errors and invalid output, cleaning up on each failure', async () => {
  const file = await officeFile()
  for (const [code, status] of [
    ['timeout', 504],
    ['unavailable', 503],
    ['invalid-document', 422],
    ['output-too-large', 413],
    ['failed', 500],
    ['invalid-output', 500],
  ]) {
    let request,
      disposed = false
    const renderer = new OfficeAssetPreviewRenderer({
      createConverter: async () => ({
        async render(input) {
          request = input
          await writeFile(input.outputPath, 'invalid partial PDF')
          if (code !== 'invalid-output')
            throw Object.assign(new Error('private implementation detail'), {
              code,
            })
          return { backend: 'native', missingFonts: [] }
        },
        async dispose() {
          disposed = true
        },
      }),
    })
    await assert.rejects(renderer.render(file), (error) => {
      assert.equal(error.status, status)
      assert.doesNotMatch(error.message, /private implementation detail/)
      return true
    })
    assert.equal(disposed, true)
    await assert.rejects(stat(dirname(request.inputPath)), { code: 'ENOENT' })
  }
})

test('Office preview propagates cancellation and its own deadline to the converter before cleanup', async () => {
  const file = await officeFile()
  for (const cancelled of [true, false]) {
    let request,
      disposed = false
    const started = Promise.withResolvers()
    const controller = new AbortController()
    const renderer = new OfficeAssetPreviewRenderer({
      timeoutMs: cancelled ? 1000 : 30,
      createConverter: async () => ({
        async render(input, signal) {
          request = input
          started.resolve()
          await new Promise((resolve, reject) => {
            if (signal.aborted) reject(signal.reason)
            else
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              })
          })
        },
        async dispose() {
          disposed = true
        },
      }),
    })
    const rendered = renderer.render(file, controller.signal)
    await started.promise
    if (cancelled) controller.abort(new Error('client closed'))
    // A real worker keeps Node alive; the fake converter needs a ref while the unref'ed timer runs.
    const keepAlive = setTimeout(() => {}, 1000)
    try {
      await assert.rejects(
        rendered,
        cancelled ? /client closed/ : { status: 504 },
      )
    } finally {
      clearTimeout(keepAlive)
    }
    assert.equal(disposed, true)
    await assert.rejects(stat(dirname(request.inputPath)), { code: 'ENOENT' })
  }
})

test('asset preview route requires management permission and owner access before conversion', async (t) => {
  const file = await officeFile()
  const owner = { userId: 'owner', permissions: ['agents.manage'] }
  const accounts = {
    owner,
    other: { ...owner, userId: 'other' },
    member: { userId: 'member', permissions: [] },
  }
  let conversions = 0
  const service = new BusinessAgentService({
    db: {
      async query(sql, [id, ownerId]) {
        assert.match(sql, /WHERE id=\$1 AND owner_user_id=\$2/)
        return id === 'asset-one' && ownerId === 'owner'
          ? [{ id, name: file.filename, content: file.content }]
          : []
      },
    },
    async renderOfficePreview(input, signal) {
      conversions++
      assert.deepEqual(input, file)
      assert.equal(signal.aborted, false)
      return {
        name: '销售资料.pdf',
        mediaType: 'application/pdf',
        contentBase64: pdf.toString('base64'),
        missingFonts: [],
      }
    },
  })
  const router = new ApiRouter(async (request, permission) => {
    const account = accounts[request.headers.authorization]
    if (!account) throw new ApiError(401, 'authentication required')
    requirePermission(account, permission)
    return account
  })
  registerBusinessAgentRoutes(router, service)
  const server = createServer((request, response) =>
    router.handle(request, response, {
      signal: AbortSignal.timeout(5000),
    }),
  )
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(done)
      }),
  )
  const url = `http://127.0.0.1:${server.address().port}/api/v2/admin/agents/assets/asset-one/preview`
  for (const [authorization, status] of [
    ['', 401],
    ['member', 403],
    ['other', 404],
  ]) {
    const response = await fetch(url, { headers: { authorization } })
    assert.equal(response.status, status)
  }
  assert.equal(conversions, 0)
  const response = await fetch(url, { headers: { authorization: 'owner' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).contentBase64, pdf.toString('base64'))
  assert.equal(conversions, 1)
})
