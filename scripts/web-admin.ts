/** 根入口保持 CommonJS 兼容，通过动态导入进入新管理端独立的 ESM 边界。 */
import('../apps/web-admin/scripts/cli.ts')
  .then(({ main }) => main(process.argv[2], process.argv.slice(3)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '新管理端命令失败')
    process.exitCode = 1
  })
