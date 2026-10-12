export type MenuNode = {
  id: string
  kind: 'group' | 'page'
  moduleId: string | null
  parentId: string | null
  title: string
  icon: string
  order: number
  visible: boolean
  roleIds: string[]
}

export type NavigationResponse = { version: number; items: MenuNode[] }

export type MenuModule = {
  id: string
  route: string
  title: string
  icon: string
  permissions: string[]
}

export type MenusResponse = NavigationResponse & {
  modules: MenuModule[]
  icons: string[]
  roles: { id: string; name: string }[]
}
