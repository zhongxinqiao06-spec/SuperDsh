import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  result,
  rows,
  string,
  type Row,
  type Request,
  type Run,
} from './platform-model.ts'
export function RemoteFiles({
  device,
  workspace,
  online,
  busy,
  request,
  run,
  initialPath = '',
}: {
  device: string
  workspace: string
  online: boolean
  busy: boolean
  request: Request
  run: Run
  initialPath?: string
}) {
  const [path, setPath] = useState(initialPath)
  const [text, setText] = useState('')
  const [version, setVersion] = useState<{
    path: string
    sha256: string
  } | null>(null)
  const [entries, setEntries] = useState<Row[]>([])
  const read = async () => {
    const value = result(
      await request({
        operation: 'read-file',
        connectorId: device,
        query: { root: workspace },
        body: { path, maxBytes: 1048576 },
      }),
    )
    if (value.binary === true || value.truncated === true)
      throw new Error('仅可编辑完整文本文件（最大 1 MiB）')
    setText(string(value.content))
    setVersion({ path, sha256: string(value.sha256) })
  }
  return (
    <section aria-label="目标设备文件">
      <div className="platformActions">
        <Input
          aria-label="文件路径"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="相对工作区路径"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !online || !workspace}
          onClick={() => {
            void run(async () => {
              const value = result(
                await request({
                  operation: 'files',
                  connectorId: device,
                  body: { root: workspace, path: path || '.' },
                }),
              )
              setEntries(rows(value.entries))
            })
          }}
        >
          列目录
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !online || !path}
          onClick={() => {
            void run(read)
          }}
        >
          读取
        </Button>
      </div>
      {entries.map((entry) => (
        <Button
          size="sm"
          key={string(entry.path) || string(entry.name)}
          onClick={() => setPath(string(entry.path) || string(entry.name))}
        >
          {string(entry.name)} {string(entry.type)}
        </Button>
      ))}
      <textarea
        className="platformEditor"
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="远端文件内容"
      />
      <Button
        size="sm"
        variant="primary"
        disabled={busy || !online || !path || version?.path !== path}
        onClick={() => {
          void run(async () => {
            await request({
              operation: 'write-file',
              connectorId: device,
              query: { root: workspace },
              body: { path, content: text, ifMatch: version?.sha256 ?? '' },
            })
            await read()
          })
        }}
      >
        保存到目标设备
      </Button>
    </section>
  )
}
