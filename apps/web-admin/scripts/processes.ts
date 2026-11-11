import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import { repositoryRoot } from './paths.ts'

/** 前台子进程沿用 stdio；Windows 不经过 cmd 包装，退出状态完整传播。 */
export function launch(
  command: string,
  args: string[],
  options: SpawnOptions = {},
) {
  return spawn(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
    ...options,
  })
}

/** 任一步失败都中止命令，不把未执行的后续检查记录为通过。 */
export async function run(
  command: string,
  args: string[],
  options: SpawnOptions = {},
) {
  const child = launch(command, args, options)
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} 退出：${code ?? signal}`)),
    )
  })
}

/** 先发送正常退出，宽限期之后才回收本入口拥有的进程树。 */
export async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const waitForExit = (milliseconds: number) =>
    new Promise<boolean>((done) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return done(true)
      const closed = () => {
        clearTimeout(timer)
        done(true)
      }
      const timer = setTimeout(() => {
        child.off('close', closed)
        done(false)
      }, milliseconds)
      child.once('close', closed)
    })
  if (child.stdin?.writable) {
    // EPIPE 表示管道已关闭，继续检查实际退出，不将写失败误认为已回收。
    child.stdin.once('error', () => {})
    child.stdin.end('{"command":"shutdown"}\n')
  } else if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  } else {
    process.kill(-child.pid, 'SIGTERM')
  }
  if (await waitForExit(90000)) return
  if (process.platform === 'win32')
    await run('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  else process.kill(-child.pid, 'SIGKILL')
  if (!(await waitForExit(5000)))
    throw new Error(`进程树未在宽限期内退出：${child.pid}`)
}

/** 任一服务退出即关闭同组服务，避免留下一半工作的开发环境。 */
export async function supervise(children: ChildProcess[]) {
  let failure: Error | undefined
  let interrupt: () => void = () => {}
  const cleanup: (() => void)[] = []
  try {
    await new Promise<void>((resolve) => {
      interrupt = () => resolve()
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', interrupt)
      // 仅受管调用显式开启控制管道；普通终端重定向/空 stdin 不应结束开发服务。
      if (process.env.WEB_ADMIN_CONTROL_STDIN === '1') {
        const input = createInterface({ input: process.stdin })
        const line = (value: string) => {
          try {
            if (JSON.parse(value).command === 'shutdown') interrupt()
          } catch {
            // 非控制 JSON 不改变服务状态，避免误把输入视为 shell 命令。
          }
        }
        input.on('line', line)
        input.once('close', interrupt)
        cleanup.push(() => {
          input.off('line', line)
          input.off('close', interrupt)
          input.close()
        })
      }
      for (const child of children) {
        const error = (value: Error) => {
          failure = value
          resolve()
        }
        const exited = (code: number | null, signal: NodeJS.Signals | null) => {
          if (code && !signal) failure = new Error(`服务异常退出 ${code}`)
          resolve()
        }
        child.once('error', error)
        child.once('exit', exited)
        cleanup.push(() => {
          child.off('error', error)
          child.off('exit', exited)
        })
        if (child.exitCode !== null || child.signalCode !== null)
          exited(child.exitCode, child.signalCode)
      }
    })
    const stopped = await Promise.allSettled(children.map(stop))
    for (const result of stopped)
      if (result.status === 'rejected')
        failure ??= new Error(`资源回收失败：${String(result.reason)}`)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    for (const dispose of cleanup) dispose()
  }
  if (failure) throw failure
}
