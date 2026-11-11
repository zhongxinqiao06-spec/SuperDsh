declare const __WEB_ADMIN_BUILD__: {
  version: string
  commit: string
  builtAt: string
  engine: { version: string; source: string }
}

/** Vite从统一构建元数据注入此对象，页面通过本模块读取版本。 */
export const buildInfo = __WEB_ADMIN_BUILD__
