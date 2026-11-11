/** 行操作展示契约；权限过滤由领域页面负责，组件仅处理可用性与事件。 */
export interface RowAction {
  key: string
  label: string
  disabled?: boolean
  reason?: string
  danger?: boolean
}
