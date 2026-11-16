import { createServer } from 'node:http'
import { once } from 'node:events'

type ChatBody = {
  model: string
  messages: { role: string; content: unknown }[]
  tools?: { function: { name: string } }[]
}

const sourceName = 'sales-example.csv'

/** 从 DSH 返回的工具结果提取已检索的 CSV，模型只能基于这份会话资料生成计划。 */
function inspectedDocument(
  input: unknown,
): { sourceId: string; text: string } | undefined {
  if (typeof input === 'string') {
    if (!['{', '['].includes(input.trim()[0] ?? '')) return
    try {
      return inspectedDocument(JSON.parse(input))
    } catch {
      return
    }
  }
  if (input && typeof input === 'object') {
    if (
      'sourceId' in input &&
      'text' in input &&
      typeof input.sourceId === 'string' &&
      typeof input.text === 'string'
    )
      return { sourceId: input.sourceId, text: input.text }
    for (const child of Object.values(input)) {
      const found = inspectedDocument(child)
      if (found) return found
    }
  }
}

function reportFromCSV(doc: { sourceId: string; text: string }) {
  const totals = new Map<string, number>()
  const rows = doc.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+月\s*\|/.test(line))
  for (const row of rows) {
    const [month, , revenue] = row.split('|').map((value) => value.trim())
    if (!month || !revenue || !Number.isFinite(Number(revenue)))
      throw new Error('工具返回未知的 CSV 行')
    totals.set(month, (totals.get(month) ?? 0) + Number(revenue))
  }
  if (rows.length !== 12 || totals.size !== 3)
    throw new Error('附件的十二行销售记录未完整返回')
  const quarter = [...totals.values()].reduce((a, b) => a + b) / 10000
  return {
    title: '第三季度经营简报',
    tableOfContents: false,
    // 质量检查会从真实 PDF 读取嵌入字体；镜像安装思源字体，Windows 默认安装微软雅黑。
    brand: {
      fontFace:
        process.env.WEB_ADMIN_TEST_DOCUMENT_FONT ??
        (process.platform === 'win32' ? 'Microsoft YaHei' : 'Noto Sans CJK SC'),
    },
    sections: [
      {
        id: 'sales',
        title: '销售额核对',
        blocks: [
          {
            type: 'paragraph',
            text: `季度销售额合计 ${quarter.toFixed(1)} 万元。`,
          },
          {
            type: 'table',
            columns: ['月份', '销售额（万元）'],
            rows: [...totals].map(([month, amount]) => [
              month,
              (amount / 10000).toFixed(1),
            ]),
          },
          { type: 'quote', text: rows[0], sourceId: doc.sourceId },
        ],
      },
    ],
  }
}

/** 本地有界 SSE 驱动仅代替供应商。工具发现、执行、用户确认、持久化、渲染全部经过正式平台。 */
export async function startOfficeModel() {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/chat/completions') {
        res.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        const data = Buffer.from(chunk)
        size += data.length
        if (size > 8 * 1024 * 1024) throw new Error('请求过大')
        chunks.push(data)
      }
      const body: ChatBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const tool = body.tools?.find((item) =>
        item.function.name.startsWith('bound_'),
      )?.function.name
      const history = body.messages.filter((item) => item.role === 'tool')
      const inspected = history.length
        ? inspectedDocument(history[0]?.content)
        : undefined
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (
        delta: Record<string, unknown>,
        finish: string | null = null,
      ) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'office-fixture',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: finish }],
            }) +
            '\n\n',
        )
      send({ role: 'assistant' })
      if (tool && history.length < 2 && (!history.length || inspected)) {
        const phase = inspected ? 'plan' : 'inspect'
        const args = {
          action: phase,
          inputsJson: JSON.stringify([{ attachmentName: sourceName }]),
          ...(inspected
            ? { planJson: JSON.stringify(reportFromCSV(inspected)) }
            : {}),
        }
        console.log('办公模型收到已装配工具，阶段', phase)
        send({
          tool_calls: [
            {
              index: 0,
              id: 'office-' + phase,
              type: 'function',
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          ],
        })
        send({}, 'tool_calls')
      } else if (!tool) {
        // 会话标题等后台请求不装配业务工具。
        send({ content: '第三季度销售核对' })
        send({}, 'stop')
      } else {
        send({
          content:
            history.length >= 2
              ? '请在成果区核对生成的文档及其来源。'
              : '本次未取得预期的文档资料。',
        })
        send({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    } catch (error) {
      console.error(
        '受控办公模型失败',
        error instanceof Error ? error.message : 'unknown',
      )
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('受控模型未绑定端口')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()))
        server.closeAllConnections()
      }),
  }
}
