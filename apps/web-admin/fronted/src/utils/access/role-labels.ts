const names: Record<string, readonly [string, string]> = {
  admin: ['平台超管', 'Platform administrator'],
  member: ['办公用户', 'Office user'],
  office_admin: ['办公管理员', 'Office administrator'],
  entertainment_admin: ['娱乐管理员', 'Studio administrator'],
  entertainment_creator: ['娱乐创作者', 'Studio creator'],
}

/** 自定义角色保留服务端名称，内置角色在产品切换与账号展示中采用同一称呼。 */
export function roleLabel(
  id: string,
  tr: (zh: string, en: string) => string,
  fallback = id,
): string {
  const label = names[id]
  return label ? tr(...label) : fallback
}
