import type {
  PlatformJson,
  PlatformRequest,
} from '@superdsh/core/client/platform'
export type Request = (value: PlatformRequest) => Promise<PlatformJson>
export type Run = (action: () => Promise<void>) => Promise<void>
export type Row = { [key: string]: PlatformJson }
export const object = (value: PlatformJson | undefined): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
export const rows = (value: PlatformJson | undefined): Row[] =>
  Array.isArray(value) ? value.map(object) : []
export const string = (value: PlatformJson | undefined): string =>
  typeof value === 'string' ? value : ''
export const result = (value: PlatformJson): Row => {
  const body = object(value)
  return body.result && typeof body.result === 'object'
    ? object(body.result)
    : body
}
export const labels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
}
export function contentText(value: PlatformJson | undefined): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value))
    return value.map(contentText).filter(Boolean).join('\n')
  const content = object(value)
  return (
    string(content.text) ||
    string(content.markdown) ||
    contentText(content.blocks) ||
    string(content.output) ||
    string(content.message)
  )
}
