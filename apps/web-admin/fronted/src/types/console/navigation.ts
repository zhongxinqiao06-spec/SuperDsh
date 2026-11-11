/** 导航配置与业务权限分离，隐藏菜单不撤销模块访问权。 */
export interface MenuNode {
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

/** 已完成名称、路由与选中态解析的导航展示项，不包含请求或权限规则。 */
export interface NavigationDisplayItem {
  id: string
  kind: MenuNode['kind']
  parentId: string | null
  title: string
  icon: string
  path: string
  active: boolean
}

/** 与服务端导航目录保持一致的模块描述。 */
export interface ConsoleModule {
  id: string
  path: string
  title: string
  englishTitle: string
  icon: string
  permissions: readonly string[]
  implemented: boolean
}

/** 管理菜单携带乐观并发版本；版本取自业务记录。 */
export interface NavigationResponse {
  version: number
  items: MenuNode[]
}
export interface MenusResponse extends NavigationResponse {
  modules: {
    id: string
    route: string
    title: string
    icon: string
    permissions: string[]
  }[]
  icons: string[]
  roles?: { id: string; name: string }[]
}
