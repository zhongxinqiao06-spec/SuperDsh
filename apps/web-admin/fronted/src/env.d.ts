/** 构建元数据由根构建步骤注入；业务不能重复声明发布版本。 */
declare const __WEB_ADMIN_BUILD__: {
  version: string
  commit: string
  builtAt: string
  engine: { version: string; source: string }
}
/** 官网图表与公开的 CSV 下载采用同一份源文件。 */
declare const __PUBLIC_SALES_EXAMPLE__: string
