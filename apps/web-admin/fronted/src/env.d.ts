/** 构建元数据由根构建步骤注入；业务不能重复声明发布版本。 */
declare const __WEB_ADMIN_BUILD__: {
  version: string
  commit: string
  builtAt: string
  engine: { version: string; source: string }
}
