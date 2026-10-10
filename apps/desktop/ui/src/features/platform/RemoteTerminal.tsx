import { useEffect, useState } from 'react'
import {
  Button,
  Input,
  TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { PlatformSelect } from './PlatformSelect.tsx'
import {
  object,
  result,
  rows,
  string,
  type Row,
  type Request,
  type Run,
} from './platform-model.ts'
const labels = {
  signal: (signal: string) => `信号 ${signal}`,
  exitCode: (code: number) => `退出码 ${code}`,
  noExitCode: '已结束',
  running: '运行中',
  failed: '失败',
  done: '已完成',
  copy: '复制',
  copied: '已复制',
  noOutput: '尚无输出',
  collapseAria: '收起输出',
  collapse: '收起',
  expandAria: (count: number) => `展开 ${count} 行`,
  expand: (count: number) => `展开 ${count} 行`,
}
export function RemoteTerminal({
  device,
  workspace,
  online,
  busy,
  request,
  run,
}: {
  device: string
  workspace: string
  online: boolean
  busy: boolean
  request: Request
  run: Run
}) {
  const [id, setId] = useState(''),
    [output, setOutput] = useState(''),
    [command, setCommand] = useState('')
  const [terminals, setTerminals] = useState<Row[]>([])
  useEffect(() => {
    let disposed = false
    void request({ operation: 'terminals', connectorId: device })
      .then((value) => {
        if (!disposed) setTerminals(rows(result(value).terminals))
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [device, request])
  useEffect(() => {
    if (!id || !online) return
    let disposed = false,
      pending = false
    const update = async () => {
      if (pending) return
      pending = true
      try {
        const value = result(
          await request({
            operation: 'terminal-snapshot',
            connectorId: device,
            terminalId: id,
          }),
        )
        if (!disposed)
          setOutput(
            new TextDecoder().decode(
              Uint8Array.from(atob(string(value.dataBase64)), (char) =>
                char.charCodeAt(0),
              ),
            ),
          )
      } catch {
        /* Offline state is shown by the owning device selector. */
      } finally {
        pending = false
      }
    }
    void update()
    const timer = setInterval(() => {
      void update()
    }, 1000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [id, online, device, request])
  return (
    <section aria-label="目标设备终端">
      <div className="platformActions">
        <PlatformSelect
          label="选择终端"
          placeholder="选择已打开的终端"
          value={id}
          onChange={(next) => {
            setId(next)
            setOutput('')
          }}
          options={terminals.map((item) => ({
            value: string(item.terminalId),
            label: string(item.label) || string(item.terminalId),
          }))}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !online || !workspace}
          onClick={() => {
            void run(async () => {
              const value = result(
                await request({
                  operation: 'create-terminal',
                  connectorId: device,
                  query: { root: workspace },
                  body: { cols: 100, rows: 30, cwd: workspace },
                }),
              )
              const terminal = object(value.terminal)
              const created =
                string(value.terminalId) || string(terminal.terminalId)
              setId(created)
              setTerminals((previous) => [
                ...previous,
                { ...terminal, terminalId: created },
              ])
            })
          }}
        >
          新建终端
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !id || !online}
          onClick={() => {
            void run(async () => {
              await request({
                operation: 'terminal-close',
                connectorId: device,
                terminalId: id,
              })
              setTerminals((previous) =>
                previous.filter((item) => item.terminalId !== id),
              )
              setId('')
              setOutput('')
            })
          }}
        >
          关闭终端
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !id || !online}
          onClick={() => {
            void run(async () => {
              await request({
                operation: 'terminal-resize',
                connectorId: device,
                terminalId: id,
                body: { cols: 120, rows: 40 },
              })
            })
          }}
        >
          放大终端
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !id || !online}
          onClick={() => {
            void run(async () => {
              await request({
                operation: 'terminal-write',
                connectorId: device,
                terminalId: id,
                body: { data: '\u0003' },
              })
            })
          }}
        >
          Ctrl+C
        </Button>
      </div>
      <TerminalBlock
        command=""
        cwd={workspace}
        output={output}
        running={!!id && online}
        maxLines={100}
        labels={labels}
      />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            await request({
              operation: 'terminal-write',
              connectorId: device,
              terminalId: id,
              body: { data: command + '\r' },
            })
            setCommand('')
          })
        }}
      >
        <Input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          aria-label="终端命令"
          disabled={!id || !online}
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={busy || !id || !online}
        >
          执行
        </Button>
      </form>
    </section>
  )
}
