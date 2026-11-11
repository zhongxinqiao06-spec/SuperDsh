import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { launch, run, stop, supervise } from '../../scripts/processes.ts'

test('可协作子进程通过控制管道正常退出，重复关闭幂等', async () => {
  const child = launch(
    process.execPath,
    [
      '-e',
      "process.stdin.on('data',()=>{process.exitCode=0;process.stdin.destroy()});process.stdout.write('ready')",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  await once(child.stdout!, 'data')
  await stop(child)
  assert.equal(child.exitCode, 0)
  await stop(child)
})

test('启动失败立即传播且清理不会永远等待未产生的PID', async () => {
  await assert.rejects(run('superdsh-missing-validation-executable', []))
  const child = launch('superdsh-missing-validation-executable', [])
  await once(child, 'error')
  await stop(child)
  assert.equal(child.pid, undefined)
})

test('同组服务失败后回收其余进程并移除父信号监听', async () => {
  const before = process.listenerCount('SIGINT')
  const waiting = launch(
    process.execPath,
    ['-e', "process.stdin.on('data',()=>process.stdin.destroy())"],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  )
  const failing = launch(process.execPath, ['-e', 'process.exitCode=7'])
  await assert.rejects(supervise([waiting, failing]), /异常退出/)
  assert.equal(waiting.exitCode, 0)
  assert.equal(process.listenerCount('SIGINT'), before)
})
