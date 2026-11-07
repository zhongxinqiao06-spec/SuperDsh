import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolImplementation } from '@superdsh/core/contracts/extensions'
import { ApiError } from '../http/api-router.ts'
import { providerRequest } from '../models/provider-http.ts'
import { installedEntrypoint } from './process.ts'
import { ManagedMcpStdio } from './mcp-stdio.ts'
import { validateSchema } from './validation.ts'

export type McpConnection =
  | { kind: 'http'; endpoint: string; token?: string; allowedOrigins: string }
  | {
      kind: 'stdio'
      installation: string
      entrypoint: string
      workDirectory: string
    }

/** Remote URLs are DNS-pinned, never redirected, and cannot inherit platform cookies. */
export function mcpFetch(
  connection: Extract<McpConnection, { kind: 'http' }>,
): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (url !== connection.endpoint)
      throw new ApiError(403, 'MCP 请求越出已配置的端点')
    const headers = new Headers(init?.headers)
    if (connection.token)
      headers.set('Authorization', `Bearer ${connection.token}`)
    const body =
      typeof init?.body === 'string' ? Buffer.from(init.body) : undefined
    if (init?.body && !body) throw new ApiError(422, 'MCP 请求内容格式不受支持')
    const response = await providerRequest({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(headers),
      body,
      personal: true,
      allowedOrigins: connection.allowedOrigins,
      signal: init?.signal ?? AbortSignal.timeout(30000),
    })
    const returned = new Headers()
    for (const [key, value] of Object.entries(response.headers))
      if (value !== undefined)
        returned.set(key, Array.isArray(value) ? value.join(', ') : value)
    return new Response(
      response.statusCode === 204 || response.statusCode === 304
        ? null
        : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
      { status: response.statusCode ?? 502, headers: returned },
    )
  }
}

export async function withMcp<T>(
  connection: McpConnection,
  signal: AbortSignal,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const client = new Client({ name: 'superdsh-tools', version: '1.0.0' })
  const transport =
    connection.kind === 'http'
      ? new StreamableHTTPClientTransport(new URL(connection.endpoint), {
          fetch: mcpFetch(connection),
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        })
      : new ManagedMcpStdio(
          await installedEntrypoint(
            connection.installation,
            connection.entrypoint,
          ),
          connection.workDirectory,
        )
  try {
    await client.connect(transport, { signal, timeout: 15000 })
    return await operation(client)
  } catch (error) {
    if (signal.aborted) throw new ApiError(499, 'MCP 调用已取消或超时')
    if (error instanceof ApiError) throw error
    // Remote messages may echo authentication, inputs or server paths.
    throw new ApiError(502, 'MCP 连接或调用失败，请检查连接与工具配置')
  } finally {
    if (transport instanceof StreamableHTTPClientTransport)
      await transport.terminateSession().catch(() => {})
    await client.close().catch(() => {})
  }
}

export async function discoverMcp(
  client: Client,
  signal: AbortSignal,
): Promise<ToolImplementation[]> {
  const tools: ToolImplementation[] = []
  let cursor: string | undefined
  const visited = new Set<string>()
  do {
    const result = await client.listTools(
      { cursor },
      { signal, timeout: 15000 },
    )
    for (const tool of result.tools) {
      if (tools.length >= 100)
        throw new ApiError(422, 'MCP 工具超过 100 个，请拆分连接')
      tools.push({
        id: /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/u.test(tool.name)
          ? tool.name
          : `mcp-${createHash('sha256').update(tool.name).digest('hex').slice(0, 20)}`,
        remoteName: tool.name,
        name: (tool.title || tool.name).slice(0, 100),
        description: (tool.description || tool.name).slice(0, 4000),
        mode: 'action',
        inputSchema: validateSchema(tool.inputSchema, `MCP ${tool.name} 输入`),
        configurationSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        outputSchema: tool.outputSchema
          ? validateSchema(tool.outputSchema, `MCP ${tool.name} 输出`)
          : undefined,
        permissions: ['sessions.run'],
        artifactTypes: [],
        timeoutSeconds: 120,
      })
    }
    cursor = result.nextCursor
    if (cursor && visited.has(cursor))
      throw new ApiError(502, 'MCP 发现游标重复')
    if (cursor) visited.add(cursor)
  } while (cursor)
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length)
    throw new ApiError(422, 'MCP 工具标识重复')
  return tools
}

export function toolSchemaDigest(tool: ToolImplementation) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: tool.id,
        remoteName: tool.remoteName,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }),
    )
    .digest('hex')
}

export async function callMcp(
  connection: McpConnection,
  tool: ToolImplementation,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  return withMcp(connection, signal, async (client) => {
    const current = (await discoverMcp(client, signal)).find(
      (item) => item.id === tool.id,
    )
    if (!current || toolSchemaDigest(current) !== toolSchemaDigest(tool))
      throw new ApiError(
        409,
        'MCP 工具或 Schema 已改变，需要管理员重新检查并授权',
      )
    return client.callTool(
      { name: tool.remoteName ?? tool.id, arguments: args },
      undefined,
      { signal, timeout: tool.timeoutSeconds * 1000 },
    )
  })
}
