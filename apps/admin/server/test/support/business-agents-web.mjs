import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createPreviewDocx } from './office-preview-fixture.mjs'

// Disposable Next server, real APIs and browser DOM; no request interception.
export async function verifyBusinessAgentManagement(page) {
  const managementGroup = page
    .locator('aside')
    .getByRole('button', { name: /^(智能体管理|Agent management)$/ })
  if ((await managementGroup.getAttribute('aria-expanded')) !== 'true')
    await managementGroup.click()
  const seeded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v2/admin/agents/initialize') &&
      response.request().method() === 'POST',
  )
  await page.locator('aside a[href="#/agents"]').click()
  const seededResponse = await seeded
  assert.equal(seededResponse.status(), 200, await seededResponse.text())
  const examples = await seededResponse.json()
  await page.getByRole('cell', { name: /企业知识助手/ }).waitFor()
  assert.equal(await page.locator('table tbody tr').count(), 4)
  assert.equal(
    await page
      .getByRole('button', { name: /初始化演示内容|Initialize demo content/ })
      .count(),
    0,
  )
  for (const route of ['#/agents', '#/knowledge', '#/skills', '#/tools'])
    assert.equal(await page.locator(`aside a[href="${route}"]`).count(), 1)

  const row = page.locator('table tbody tr').filter({ hasText: '企业知识助手' })
  await row.getByRole('button', { name: /^(编辑|Edit)$/ }).click()
  let dialog = page.getByRole('dialog')
  await dialog
    .getByRole('textbox', { name: /^(用途说明|Purpose)/ })
    .fill('Browser verified company knowledge assistant')
  await saveAndExpect(page, dialog, '/api/v2/admin/agents/', 'PUT')
  await row.getByText('Browser verified company knowledge assistant').waitFor()
  await row.getByText('v2', { exact: true }).waitFor()

  await page.locator('aside a[href="#/knowledge"]').click()
  const baseRow = page
    .locator('table tbody tr')
    .filter({ hasText: '星河商贸 · 公司资料' })
  await baseRow.waitFor()
  assert.equal(await page.locator('table tbody tr').count(), 3)
  await baseRow
    .getByRole('button', { name: /^(管理文件|Manage files)$/ })
    .click()
  const filesDialog = page.getByRole('dialog', {
    name: /管理文件 ·|Manage files ·/,
  })
  await filesDialog
    .getByRole('button', {
      name: /^(上传资料或模板|Upload resource or template)$/,
    })
    .click()
  dialog = page.getByRole('dialog', {
    name: /^(上传资料或模板|Upload resource or template)$/,
  })
  const fileInput = dialog.locator('input[type="file"]')
  assert.ok((await fileInput.getAttribute('accept')).includes('.docx'))
  await fileInput.setInputFiles({
    name: 'browser-company-guide.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      '# Fictional company\nBrowser upload verification only.',
    ),
  })
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v2/admin/agents/assets') &&
      response.request().method() === 'POST',
  )
  const linked = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v2/admin/knowledge-bases/') &&
      response.request().method() === 'PUT',
  )
  const indexed = page.waitForResponse(
    (response) =>
      /\/api\/v2\/admin\/knowledge-bases\/[^/]+\/index$/.test(response.url()) &&
      response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: /^(上传|Upload)$/ }).click()
  const uploadedResponse = await uploaded
  assert.equal(uploadedResponse.status(), 201, await uploadedResponse.text())
  const { asset } = await uploadedResponse.json()
  const linkedResponse = await linked
  assert.equal(linkedResponse.status(), 200, await linkedResponse.text())
  const { knowledgeBase } = await linkedResponse.json()
  assert.ok(knowledgeBase.assetIds.includes(asset.id))
  const indexResponse = await indexed
  assert.equal(indexResponse.status(), 200, await indexResponse.text())
  assert.ok((await indexResponse.json()).chunks > 0)
  await dialog.waitFor({ state: 'hidden' })
  await filesDialog
    .getByRole('cell', { name: 'browser-company-guide.md', exact: true })
    .waitFor()
  await filesDialog
    .getByRole('button', {
      name: /^(上传资料或模板|Upload resource or template)$/,
    })
    .click()
  dialog = page.getByRole('dialog', {
    name: /^(上传资料或模板|Upload resource or template)$/,
  })
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'browser-preview-guide.docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createPreviewDocx(),
  })
  const documentUploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v2/admin/agents/assets') &&
      response.request().method() === 'POST',
  )
  const documentIndexed = page.waitForResponse(
    (response) =>
      /\/api\/v2\/admin\/knowledge-bases\/[^/]+\/index$/.test(response.url()) &&
      response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: /^(上传|Upload)$/ }).click()
  const documentResponse = await documentUploaded
  assert.equal(documentResponse.status(), 201, await documentResponse.text())
  const documentIndexResponse = await documentIndexed
  assert.equal(
    documentIndexResponse.status(),
    200,
    await documentIndexResponse.text(),
  )
  await dialog.waitFor({ state: 'hidden' })
  await verifyOfficePreview(page, filesDialog, 'browser-preview-guide.docx', 2)
  await filesDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await filesDialog.waitFor({ state: 'hidden' })

  await page
    .locator('table tbody tr')
    .filter({ hasText: '星河商贸 · 企业汇报' })
    .getByRole('button', { name: /^(管理文件|Manage files)$/ })
    .click()
  await verifyOfficePreview(page, filesDialog, '销售汇报模板.pptx', 5)
  await filesDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await filesDialog.waitFor({ state: 'hidden' })

  await page.locator('aside a[href="#/skills"]').click()
  const skillRow = page
    .locator('table tbody tr')
    .filter({ hasText: '公司资料问答' })
  await skillRow.waitFor()
  assert.equal(await page.locator('table tbody tr').count(), 4)
  await skillRow.getByRole('button', { name: /^(编辑|Edit)$/ }).click()
  dialog = page.getByRole('dialog')
  await dialog
    .getByRole('textbox', { name: /^(执行要求|Instructions)$/ })
    .fill(
      'Read the linked company resources. Cite the source and clearly identify missing facts.',
    )
  const editedSkill = await saveAndExpect(
    page,
    dialog,
    '/api/v2/admin/skills/',
    'PUT',
  )
  assert.match(editedSkill.skill.instructions, /Cite the source/)

  await page.locator('aside a[href="#/tools"]').click()
  const toolRow = page
    .locator('table tbody tr')
    .filter({ hasText: 'knowledge_search' })
  await toolRow.waitFor()
  assert.equal(await page.locator('table tbody tr').count(), 5)
  await toolRow.getByRole('button', { name: /^(编辑|Edit)$/ }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('spinbutton', { name: '检索结果数量' }).fill('3')
  const editedTool = await saveAndExpect(
    page,
    dialog,
    '/api/v2/admin/tools/',
    'PUT',
  )
  assert.equal(editedTool.tool.settings.maxResults, 3)

  await page.locator('aside a[href="#/agents"]').click()
  await page
    .getByRole('button', { name: /^(新增智能体|Create agent)$/ })
    .click()
  dialog = page.getByRole('dialog')
  await dialog
    .getByRole('textbox', { name: /^(名称|Name)/ })
    .fill('Browser configured agent')
  await dialog
    .getByRole('textbox', { name: /^(用途说明|Purpose)/ })
    .fill('A minimal real browser chat configuration')
  await dialog
    .getByRole('textbox', { name: /^(工作要求|Instructions)/ })
    .fill('Answer the user clearly. Do not claim to generate files.')
  await dialog.getByRole('checkbox', { name: /星河商贸 · 公司资料/ }).check()
  await dialog.getByRole('checkbox', { name: /公司资料问答/ }).check()
  await dialog.getByRole('checkbox', { name: /查询公司资料/ }).check()
  await dialog
    .getByRole('checkbox', { name: /发布到工作台|Publish to workspace/ })
    .check()
  const { agent } = await saveAndExpect(
    page,
    dialog,
    '/api/v2/admin/agents',
    'POST',
    201,
  )
  assert.equal(agent.name, 'Browser configured agent')
  assert.equal(agent.published, true)
  assert.deepEqual(agent.knowledgeBaseIds, [knowledgeBase.id])
  assert.deepEqual(agent.skillIds, ['company-knowledge'])
  assert.deepEqual(agent.toolIds, ['knowledge_search'])
  await page.getByRole('cell', { name: /Browser configured agent/ }).waitFor()
  return {
    knowledgeAgentId: agent.id,
    spreadsheetAgentId: examples.agents.find((item) =>
      item.toolIds.includes('spreadsheet_report'),
    ).id,
    spreadsheetInputs: [
      {
        assetId: examples.assets.find((item) => item.name.endsWith('.csv')).id,
        role: 'input',
      },
      {
        assetId: examples.assets.find(
          (item) => item.kind === 'spreadsheet-template',
        ).id,
        role: 'template',
      },
    ],
  }
}

async function verifyOfficePreview(page, filesDialog, name, totalPages) {
  const diagnostics = { console: [], errors: [], network: [], workers: [] }
  const record = (items, entry) => {
    items.push(entry)
    if (items.length > 50) items.shift()
  }
  const onConsole = (message) =>
    record(diagnostics.console, {
      type: message.type(),
      text: message.text().slice(0, 2000),
    })
  const onError = (error) => record(diagnostics.errors, error.message)
  const requestPath = (url) => {
    const { origin, pathname } = new URL(url)
    return `${origin}${pathname}`
  }
  const onRequestFailed = (request) =>
    record(diagnostics.network, {
      path: requestPath(request.url()),
      method: request.method(),
      failure: request.failure()?.errorText,
    })
  const onResponse = (response) => {
    if (response.status() >= 400 || response.url().endsWith('/preview'))
      record(diagnostics.network, {
        path: requestPath(response.url()),
        status: response.status(),
      })
  }
  const onWorker = (worker) =>
    record(diagnostics.workers, requestPath(worker.url()))
  page.on('console', onConsole)
  page.on('pageerror', onError)
  page.on('requestfailed', onRequestFailed)
  page.on('response', onResponse)
  page.on('worker', onWorker)
  let stage = 'opening preview'
  const responsePending = page.waitForResponse(
    (response) =>
      /\/api\/v2\/admin\/agents\/assets\/[^/]+\/preview$/.test(
        response.url(),
      ) && response.request().method() === 'GET',
    { timeout: 90_000 },
  )
  const downloads = []
  const onDownload = (download) => downloads.push(download)
  page.on('download', onDownload)
  try {
    await filesDialog
      .locator('table tbody tr')
      .filter({ hasText: name })
      .getByRole('button', { name: /^(查看|View)$/ })
      .click()
    stage = 'waiting for document conversion'
    const response = await responsePending
    assert.equal(response.status(), 200, await response.text())
    const rendered = await response.json()
    assert.equal(rendered.mediaType, 'application/pdf')
    assert.equal(
      Buffer.from(rendered.contentBase64, 'base64').subarray(0, 5).toString(),
      '%PDF-',
    )
    stage = 'loading PDF document in the browser'
    const previewDialog = page.getByRole('dialog', { name, exact: true })
    await previewDialog
      .getByText(`1 / ${totalPages}`, { exact: true })
      .waitFor()
    stage = 'rendering the first page'
    await verifyRenderedPage(previewDialog, 1)
    await captureOfficePreview(page, previewDialog, name, rendered, diagnostics)
    stage = 'changing pages'
    const previous = previewDialog.getByRole('button', {
      name: /^(上一页|Previous page)$/,
    })
    const next = previewDialog.getByRole('button', {
      name: /^(下一页|Next page)$/,
    })
    assert.equal(await previous.isDisabled(), true)
    assert.equal(await next.isEnabled(), true)
    await next.click()
    await previewDialog
      .getByText(`2 / ${totalPages}`, { exact: true })
      .waitFor()
    await verifyRenderedPage(previewDialog, 2)
    await previous.click()
    await previewDialog
      .getByText(`1 / ${totalPages}`, { exact: true })
      .waitFor()
    await verifyRenderedPage(previewDialog, 1)
    stage = 'changing preview zoom'
    await previewDialog
      .getByRole('button', { name: /^(放大|Zoom in)$/ })
      .click()
    await previewDialog.getByText('125%', { exact: true }).waitFor()
    await verifyRenderedPage(previewDialog, 1)
    await previewDialog
      .getByRole('button', { name: /^(适应宽度|Fit width)$/ })
      .click()
    await previewDialog.getByText('100%', { exact: true }).waitFor()
    await verifyRenderedPage(previewDialog, 1)
    assert.equal(downloads.length, 0, 'View should not start a file download')
    await previewDialog
      .getByRole('button', { name: 'Close', exact: true })
      .click()
    await previewDialog.waitFor({ state: 'hidden' })
    assert.equal(await filesDialog.locator('canvas').count(), 0)
  } catch (cause) {
    const detail = {
      name,
      stage,
      ...diagnostics,
      dialogs: await page
        .getByRole('dialog')
        .allTextContents()
        .catch(() => []),
      alerts: await page
        .getByRole('alert')
        .allTextContents()
        .catch(() => []),
    }
    if (process.env.OFFICE_PREVIEW_SCREENSHOT_DIR) {
      const directory = resolve(process.env.OFFICE_PREVIEW_SCREENSHOT_DIR)
      const stem = name.endsWith('.docx') ? 'docx' : 'pptx'
      await mkdir(directory, { recursive: true })
      await page
        .screenshot({ path: join(directory, `${stem}-failure.png`) })
        .catch(() => undefined)
      await writeFile(
        join(directory, `${stem}-failure.json`),
        `${JSON.stringify(detail, null, 2)}\n`,
      )
    }
    throw new Error(`Office preview failed: ${JSON.stringify(detail)}`, {
      cause,
    })
  } finally {
    page.off('download', onDownload)
    page.off('console', onConsole)
    page.off('pageerror', onError)
    page.off('requestfailed', onRequestFailed)
    page.off('response', onResponse)
    page.off('worker', onWorker)
  }
}

async function captureOfficePreview(page, dialog, name, rendered, diagnostics) {
  if (!process.env.OFFICE_PREVIEW_SCREENSHOT_DIR) return
  const directory = resolve(process.env.OFFICE_PREVIEW_SCREENSHOT_DIR)
  await mkdir(directory, { recursive: true })
  const stem = name.endsWith('.docx') ? 'docx' : 'pptx'
  const canvas = dialog.locator('canvas')
  const image = await canvas.evaluate((element) =>
    element.toDataURL('image/png'),
  )
  const geometry = await canvas.evaluate((element) => {
    const viewport = element.closest(
      '[aria-label="Document pages"], [aria-label="文档页面"]',
    )
    const bounds = (node) => {
      const { x, y, width, height, top, right, bottom, left } =
        node.getBoundingClientRect()
      return { x, y, width, height, top, right, bottom, left }
    }
    return {
      canvas: bounds(element),
      viewport: viewport && {
        ...bounds(viewport),
        clientWidth: viewport.clientWidth,
        clientHeight: viewport.clientHeight,
        scrollWidth: viewport.scrollWidth,
        scrollHeight: viewport.scrollHeight,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      },
      browser: { width: window.innerWidth, height: window.innerHeight },
    }
  })
  await page.screenshot({
    path: join(directory, `${stem}-preview.png`),
    animations: 'disabled',
  })
  await writeFile(
    join(directory, `${stem}-page-1.png`),
    Buffer.from(image.split(',')[1], 'base64'),
  )
  await writeFile(
    join(directory, `${stem}-preview.pdf`),
    Buffer.from(rendered.contentBase64, 'base64'),
  )
  await writeFile(
    join(directory, `${stem}-geometry.json`),
    `${JSON.stringify(geometry, null, 2)}\n`,
  )
  await writeFile(
    join(directory, `${stem}-diagnostics.json`),
    `${JSON.stringify(diagnostics, null, 2)}\n`,
  )
}

export async function verifyRenderedPage(dialog, pageNumber) {
  const canvas = dialog.locator('canvas')
  await canvas.waitFor({ state: 'visible', timeout: 30_000 })
  assert.match(
    await canvas.getAttribute('aria-label'),
    new RegExp(`第 ${pageNumber} 页|page ${pageNumber}$`),
  )
  const pixels = await canvas.evaluate((element) => {
    const { data } = element
      .getContext('2d')
      .getImageData(0, 0, element.width, element.height)
    let colored = 0
    for (let index = 0; index < data.length; index += 4)
      if (
        data[index + 3] > 0 &&
        (data[index] < 240 || data[index + 1] < 240 || data[index + 2] < 240)
      )
        colored++
    return { width: element.width, height: element.height, colored }
  })
  assert.ok(pixels.width > 100 && pixels.height > 100)
  assert.ok(
    pixels.colored > 20,
    'The preview must contain rendered page content',
  )
}

async function saveAndExpect(page, dialog, path, method, status = 200) {
  const pending = page.waitForResponse(
    (response) =>
      response.url().includes(path) && response.request().method() === method,
  )
  await dialog.getByRole('button', { name: /^(保存|Save)$/ }).click()
  const response = await pending
  assert.equal(response.status(), status, await response.text())
  const result = await response.json()
  await dialog.waitFor({ state: 'hidden' })
  return result
}
