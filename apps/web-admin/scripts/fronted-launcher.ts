import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { appRoot } from './paths.ts'

/** 开发服务器采用协作关闭，先释放Vite/HMR/构建进程，再结束父进程。 */
async function main() {
  const pending = createServer({
    configFile: resolve(appRoot, 'fronted/vite.config.ts'),
    // 由 Vite 的模块运行器加载 TS 配置，不依赖根工程的 CommonJS/ESM 类型推断。
    configLoader: 'runner',
    server: {
      port: Number(process.env.WEB_ADMIN_FRONTED_PORT),
      strictPort: true,
    },
  })
  let stopping = false
  const input = createInterface({ input: process.stdin })
  const stop = async () => {
    if (stopping) return
    stopping = true
    input.close()
    const server = await pending
    await server.close()
  }
  const shutdown = () => {
    void stop().catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
  }
  input.on('line', (line) => {
    try {
      if (JSON.parse(line)?.command === 'shutdown') shutdown()
    } catch {
      /* 非控制行不能改变生命周期。 */
    }
  })
  input.once('close', shutdown)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  const server = await pending
  if (!stopping) {
    await server.listen()
    server.printUrls()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
