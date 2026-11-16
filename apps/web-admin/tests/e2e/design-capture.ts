import type { Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 显式视觉验收只保留合成页面截图，输出限定在隔离验证目录。 */
export async function captureDesign(page: Page, name: string) {
  const target = process.env.WEB_ADMIN_DESIGN_CAPTURE_DIR
  if (!target) return
  const root = fileURLToPath(
    new URL(
      '../../../../.superdsh-work/web-admin-validation/',
      import.meta.url,
    ),
  )
  const directory = resolve(target)
  const child = relative(root, directory)
  if (!child || child.startsWith('..') || isAbsolute(child))
    throw new Error('视觉验收截图必须输出到独立验证目录')
  if (!/^[a-z0-9.-]+\.png$/iu.test(name))
    throw new Error('视觉验收截图名称不能包含路径')
  await mkdir(directory, { recursive: true })
  await page.screenshot({
    path: resolve(directory, name),
    animations: 'disabled',
  })
}
