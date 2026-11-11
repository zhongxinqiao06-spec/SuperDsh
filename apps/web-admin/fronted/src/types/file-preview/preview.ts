/** 独立预览只接受明确来源；路径票据不能被路由参数扩大权限。 */
export interface PreviewLocation {
  connectorId: string
  root: string
  path: string
  name: string
  previewToken: string
  sourceUrl: string
  mediaType: string
  line: number
  column: number
}

/** 交换后的会话只保存在当前页面内存，刷新需重新签发入口票据。 */
export interface PreviewSession {
  previewAccessToken: string
  connectorId: string
  root: string
  path: string
}
