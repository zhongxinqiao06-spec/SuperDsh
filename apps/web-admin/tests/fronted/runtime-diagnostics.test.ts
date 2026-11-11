import { describe, expect, it } from 'vitest'
import { startupDiagnostic } from '../../engine-adapter/src/startup-diagnostics'

describe('固定引擎安全启动诊断', () => {
  it('只保留阶段、内置错误类别和白名单错误码', () => {
    const error = Object.assign(new TypeError('private-message'), {
      code: 'ENOENT',
      name: 'private-name',
      stack: 'private-stack',
    })
    expect(startupDiagnostic('host-start', error)).toStrictEqual({
      stage: 'host-start',
      name: 'TypeError',
      code: 'ENOENT',
    })
  })

  it('未知错误码与非异常对象不能把凭据传入诊断', () => {
    const error = Object.assign(new Error('private-message'), {
      code: 'private-token',
    })
    expect(startupDiagnostic('bridge-service', error)).toStrictEqual({
      stage: 'bridge-service',
      name: 'Error',
      code: 'unclassified',
    })
    expect(startupDiagnostic('host-start', 'private-key')).toStrictEqual({
      stage: 'host-start',
      name: 'UnknownError',
      code: 'unclassified',
    })
  })

  it('不调用异常对象的自定义字段 getter', () => {
    const error = new Error('private-message')
    Object.defineProperty(error, 'code', {
      get: () => {
        throw new Error('不可读取的密钥')
      },
    })
    expect(startupDiagnostic('host-stop', error).code).toBe('unclassified')
  })
})
