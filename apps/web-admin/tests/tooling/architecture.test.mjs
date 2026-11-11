import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectSource } from './ownership.ts'

test('架构检查拒绝版本路由、跨端导入和泄漏测试文件', () => {
  assert.ok(
    inspectSource('fronted/src/api/example.ts', "const route = '/api/v2/users'")
      .length,
  )
  assert.ok(
    inspectSource(
      'fronted/src/components/example.ts',
      "import x from '../../../backend/app/main'",
    ).length,
  )
  assert.ok(inspectSource('backend/app/example.test.py', 'pass').length)
  assert.ok(
    inspectSource('backend/app/integrations/tools.mjs', 'export const x = 1')
      .length,
  )
  assert.deepEqual(
    inspectSource('fronted/src/api/users.ts', "const route = '/api/users'"),
    [],
  )
})
