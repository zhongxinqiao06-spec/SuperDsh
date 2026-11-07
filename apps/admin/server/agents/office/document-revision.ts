import { ApiError, object, requiredText } from '../../http/api-router.ts'

/** Apply explicit page/section edits to the saved structure, preserving every untouched node. */
export function reviseDocumentStructure(
  previous: Record<string, unknown>,
  patchValue: unknown,
  baseHash: string,
) {
  const patch = object(patchValue)
  if (patch.baseHash !== baseHash)
    throw new ApiError(409, '成果方案版本已变化，请重新读取后修改')
  const kind = Array.isArray(previous.slides)
    ? 'slides'
    : Array.isArray(previous.sections)
      ? 'sections'
      : undefined
  if (!kind) throw new ApiError(422, '此成果不支持按页面或章节修订')
  const result = structuredClone(previous)
  const nodes = result[kind] as Record<string, unknown>[]
  if (!Array.isArray(patch.changes) || patch.changes.length > 100)
    throw new ApiError(422, '修订须包含至多 100 项变更')
  for (const raw of patch.changes) {
    const change = object(raw)
    const id = requiredText(change.id, '页面或章节 ID', 100)
    const index = nodes.findIndex((node) => node.id === id)
    if (index < 0) throw new ApiError(422, `未找到页面或章节：${id}`)
    if (change.op === 'remove') nodes.splice(index, 1)
    else if (change.op === 'replace') {
      const value = object(change.value)
      if (value.id !== id)
        throw new ApiError(422, '替换内容须保留原页面或章节 ID')
      nodes[index] = structuredClone(value)
    } else if (change.op === 'insertAfter') {
      const value = object(change.value)
      requiredText(value.id, '新增页面或章节 ID', 100)
      if (nodes.some((node) => node.id === value.id))
        throw new ApiError(422, '新增 ID 不能重复')
      nodes.splice(index + 1, 0, structuredClone(value))
    } else throw new ApiError(422, '只支持 replace、remove、insertAfter 修订')
  }
  if (!nodes.length) throw new ApiError(422, '成果至少保留一个页面或章节')
  if (patch.designTheme !== undefined && kind === 'slides')
    result.designTheme = structuredClone(object(patch.designTheme))
  if (patch.brand !== undefined)
    result.brand = {
      ...object(result.brand ?? {}),
      ...structuredClone(object(patch.brand)),
    }
  if (patch.title !== undefined)
    result.title = requiredText(patch.title, '标题', 200)
  return result
}
