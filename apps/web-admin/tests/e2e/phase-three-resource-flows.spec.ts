import { test } from '@playwright/test'
import { installResourceFixture } from '../parity/resource-fixture'
import {
  exerciseResourceScenario,
  resourceScenarios,
} from '../parity/resource-actions'

/** 填充列表、真实交互与请求断言；每例独立合成状态，不写日常环境或依赖成功截图。 */
for (const scenario of resourceScenarios) {
  test(`填充资源流程：${scenario}`, async ({ page }) => {
    const fixture = await installResourceFixture(
      page,
      scenario === 'file-readonly' ? { permissions: ['files.read'] } : {},
    )
    await exerciseResourceScenario(page, scenario, fixture)
  })
}
