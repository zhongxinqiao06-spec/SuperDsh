import { chromium, expect } from '@playwright/test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

/** 用户授权的 PPT 真链路验收。账号和凭据驻留内存，每个生成请求只提交一次。 */
type Fields = Record<string, unknown>
const output = resolve(
  '.superdsh-work/web-admin-validation/session-lifecycle',
  `live-ppt-${randomUUID()}`,
)
await mkdir(output, { recursive: true })
const settings = JSON.parse(
  await readFile('.superdsh-work/web-admin-dev/config/settings.json', 'utf8'),
) as {
  ports: { backendPort: number; frontedPort: number }
  initialAdmin: { username: string; password: string }
}
const origin = `http://localhost:${settings.ports.frontedPort}`
const base = `http://127.0.0.1:${settings.ports.backendPort}/api`
const username = `model_probe_ppt_${randomUUID().slice(0, 8)}`
const password = randomBytes(24).toString('base64url')
let admin = '',
  member = '',
  userId = '',
  selected = ''
const sessions: string[] = [],
  results: Fields[] = [],
  cleanup: Fields = {}
const evidence: Fields = {
  username,
  sessions,
  results,
  cleanup,
  realPptGenerated: false,
}
const save = () =>
  writeFile(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
async function request(
  token: string,
  path: string,
  method = 'GET',
  body?: Fields,
): Promise<Fields> {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000),
  })
  if (!response.ok)
    throw new Error(`${method} ${path}: HTTP ${response.status}`)
  return response.status === 204 ? {} : ((await response.json()) as Fields)
}
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
})
const page = await context.newPage()
page.setDefaultTimeout(15000)
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
try {
  admin = String(
    (
      await request('', '/auth/login', 'POST', {
        identifier: settings.initialAdmin.username,
        password: settings.initialAdmin.password,
        clientName: 'PPT 链路验收',
      })
    ).accessToken,
  )
  userId = String(
    (
      await request(admin, '/admin/users', 'POST', {
        username,
        password,
        roles: ['member'],
        displayName: 'PPT 临时验证',
      })
    ).userId,
  )
  evidence.userId = userId
  await save()
  let login = await request('', '/auth/login', 'POST', {
    identifier: username,
    password,
  })
  member = String(login.accessToken)
  if (login.resetRequired) {
    await request(member, '/auth/change-password', 'POST', {
      newPassword: password,
    })
    login = await request('', '/auth/login', 'POST', {
      identifier: username,
      password,
    })
    member = String(login.accessToken)
  }
  await page.goto(`${origin}/#/login`)
  await page.getByLabel('用户名或邮箱').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await expect(page.locator('[data-console-shell]')).toBeVisible()
  await page.goto(`${origin}/#/workspace`)
  await expect(
    page.getByRole('status', { name: '服务端 Agent：已就绪' }),
  ).toBeVisible({ timeout: 100000 })
  console.log(
    `READY: temporary account and native DSH available; evidence=${output}`,
  )
  for await (const line of input) {
    if (!line.trim()) continue
    try {
      const command = JSON.parse(line) as Fields
      if (command.action === 'finish') break
      if (command.action === 'create') {
        await page.getByRole('button', { name: '新会话', exact: true }).click()
        await page.locator('.composer-agent-select .el-select__wrapper').click()
        await page
          .getByRole('option', { name: 'PPT 演示助手', exact: true })
          .click()
        await page.getByLabel('任务草稿').fill(String(command.text))
        const response = page.waitForResponse(
          (res) =>
            new URL(res.url()).pathname === '/api/sessions/create-and-start',
        )
        await page.getByRole('button', { name: '发送', exact: true }).click()
        const created = await response
        if (!created.ok())
          throw new Error(`Create failed: HTTP ${created.status()}`)
        selected = String(
          ((await created.json()) as { session: Fields }).session.id,
        )
        sessions.push(selected)
        console.log(JSON.stringify({ created: selected }))
      } else if (command.action === 'interrupt') {
        await page
          .getByRole('button', { name: '中断任务', exact: true })
          .click()
        await expect(page.getByLabel('任务草稿')).toBeEnabled({
          timeout: 25000,
        })
        results.push({ interrupted: selected })
        console.log('INTERRUPT CONFIRMED')
      } else if (command.action === 'message') {
        await page.getByLabel('任务草稿').fill(String(command.text))
        await page.getByRole('button', { name: '发送', exact: true }).click()
        console.log('MESSAGE SUBMITTED ONCE')
      } else if (command.action === 'respond') {
        console.log(
          JSON.stringify(
            await request(
              member,
              `/sessions/${selected}/runtime/notices/${encodeURIComponent(String(command.noticeId))}/respond`,
              'POST',
              {
                actionId: command.actionId,
                input: command.input,
              },
            ),
          ),
        )
      } else if (command.action === 'delete') {
        const row = page.locator('.sidebar-session.selected')

        await row.getByRole('button', { name: '会话操作' }).click()
        await page.getByRole('menuitem', { name: '删除', exact: true }).click()
        await page
          .getByRole('dialog', { name: '删除会话' })
          .getByRole('button', { name: '删除', exact: true })
          .click()
        await expect(page).toHaveURL(/#\/workspace$/)
        results.push({ deleted: selected })
        selected = ''
        console.log('HISTORY DELETED')
        await page.reload()
        await expect(page.locator('[data-console-shell]')).toBeVisible()
        const history = await request(member, '/sessions')
        if (JSON.stringify(history).includes(String(results.at(-1)?.deleted)))
          throw new Error('Deleted session returned after reload')
        results.push({ deletionSurvivedReload: true })
      } else if (command.action === 'download') {
        const listing = await request(
          member,
          `/sessions/${selected}/agent-artifacts`,
        )
        const artifacts = listing.items as Fields[]
        const artifact = artifacts.find((item) =>
          String(item.mediaType).includes('presentationml'),
        )
        if (!artifact) throw new Error('No actual PPT artifact')
        const path = `/sessions/${selected}/agent-artifacts/${encodeURIComponent(String(artifact.id))}`
        const response = await fetch(base + path + '/download', {
          headers: { Origin: origin, Authorization: `Bearer ${member}` },
          signal: AbortSignal.timeout(45000),
        })
        if (!response.ok) throw new Error(`Download HTTP ${response.status}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (
          bytes.subarray(0, 2).toString() !== 'PK' ||
          sha256 !== artifact.sha256
        )
          throw new Error('PPT download signature or digest mismatch')
        await writeFile(resolve(output, 'ai-collaboration.pptx'), bytes)
        const preview = await request(member, path + '/preview')
        if (preview.mediaType !== 'application/pdf')
          throw new Error('Expected rendered PDF preview')
        const pdf = Buffer.from(String(preview.contentBase64), 'base64')
        if (pdf.subarray(0, 4).toString() !== '%PDF')
          throw new Error('Invalid PDF preview')
        await writeFile(resolve(output, 'ai-collaboration.pdf'), pdf)
        evidence.realPptGenerated = true
        results.push({
          downloaded: artifact.id,
          bytes: bytes.length,
          sha256,
          previewBytes: pdf.length,
          missingFonts: preview.missingFonts,
        })
        console.log('PPT AND RENDERED PDF DOWNLOADED AND VERIFIED')
      }
      if (selected) {
        const snapshot = await request(member, `/sessions/${selected}/snapshot`)
        const plans = await request(member, `/sessions/${selected}/plans`)
        const artifacts = await request(
          member,
          `/sessions/${selected}/agent-artifacts`,
        )
        await writeFile(
          resolve(
            output,
            typeof command.checkpoint === 'string' &&
              /^[a-z-]+$/.test(command.checkpoint)
              ? `${command.checkpoint}.json`
              : `${selected}.json`,
          ),
          JSON.stringify({ snapshot, plans, artifacts }, null, 2),
        )
        const timeline = snapshot.timeline as { items: Fields[] }
        console.log(
          JSON.stringify({
            session: {
              id: (snapshot.session as Fields).id,
              status: (snapshot.session as Fields).status,
              updatedSeq: (snapshot.session as Fields).updatedSeq,
            },
            notices: (snapshot.notices as Fields[] | undefined)?.map(
              (item) => ({ id: item.id, status: item.status }),
            ),
            plans: (plans.items as Fields[] | undefined)?.map((item) => ({
              id: item.id,
              state: item.state,
              skillRunId: item.skillRunId,
            })),
            artifacts: (artifacts.items as Fields[] | undefined)?.map(
              (item) => ({
                id: item.id,
                name: item.name,
                deliverable: item.deliverable,
              }),
            ),
            recent: JSON.stringify(timeline.items.slice(-1)).slice(0, 500),
          }),
        )
      }
      await page.screenshot({
        path: resolve(output, 'current.png'),
        animations: 'disabled',
      })
      await save()
    } catch (error) {
      console.log(
        JSON.stringify({
          actionError: error instanceof Error ? error.message : 'unknown',
        }),
      )
      await save()
    }
  }
} finally {
  input.close()
  await browser.close()
  if (member) {
    try {
      await request(member, '/server-agent', 'DELETE')
      cleanup.runtimeStopped = true
    } catch {
      cleanup.runtimeStopped = false
    }
    try {
      await request(member, '/auth/logout', 'POST')
    } catch {
      /* 最终管理员撤销账号。 */
    }
  }
  if (admin && userId) {
    try {
      await request(admin, `/admin/users/${userId}`, 'DELETE')
      cleanup.userDisabled = true
    } catch {
      cleanup.userDisabled = false
    }
  }
  if (admin) {
    try {
      await request(admin, '/auth/logout', 'POST')
    } catch {
      /* 不暴露认证信息。 */
    }
  }
  await save()
  console.log(JSON.stringify({ cleanup, username, userId }))
}
