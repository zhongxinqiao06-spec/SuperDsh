/** Pinned transport fixture around the real Host. This process never executes tools. */
import { createServer, request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { startMockLlmServer } from './mock.mjs'

let behavior = 'slow_success'
let toolName = 'bash'
let toolArguments = '{}'
let chunkDelayMs = 35
let followupChunkDelayMs = 0
let remaining = Infinity
const calls = []
const successText = 'SUPERDSH_SERVER_AGENT_REAL_HOST_OK'
const read = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}
const respond = (response, value) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

createServer(async (request, response) => {
  if (request.url === '/stats') return respond(response, { calls })
  if (request.url === '/control') {
    const next = JSON.parse((await read(request)).toString())
    behavior = next.behavior ?? behavior
    toolName = next.toolName ?? toolName
    toolArguments = JSON.stringify(next.toolArguments ?? {})
    chunkDelayMs = next.chunkDelayMs ?? chunkDelayMs
    followupChunkDelayMs = next.followupChunkDelayMs ?? 0
    remaining = next.count ?? Infinity
    return respond(response, { ok: true })
  }
  if (request.method === 'GET' && request.url.endsWith('/models'))
    return respond(response, {
      data: [
        { id: 'fixture-model', type: 'model', display_name: 'Local fixture' },
      ],
    })
  const bytes = await read(request)
  const body = JSON.parse(bytes.toString())
  // Title generation is ancillary; it must not consume the tool/slow scenario.
  const isTitle = !body.tools?.length
  const turnHasToolResult = body.messages?.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result'),
  )
  const selected =
    turnHasToolResult && followupChunkDelayMs > 0
      ? 'slow_success'
      : isTitle || turnHasToolResult || remaining <= 0
        ? 'success'
        : behavior
  const responseChunkDelayMs =
    turnHasToolResult && followupChunkDelayMs > 0
      ? followupChunkDelayMs
      : chunkDelayMs
  if (!isTitle && !turnHasToolResult && remaining > 0) remaining -= 1
  const call = {
    index: calls.length,
    behavior: selected,
    model: body.model,
    tools: body.tools?.map((tool) => tool.name) ?? [],
    text: body.messages
      ?.filter((message) => message.role === 'user')
      .map((message) => message.content),
    finished: false,
  }
  calls.push(call)
  if (
    request.url.endsWith('/chat/completions') ||
    request.url.endsWith('/responses')
  ) {
    const isResponses = request.url.endsWith('/responses')
    call.protocol = isResponses ? 'openai-responses' : 'openai-completions'
    const id = 'fixture_' + randomUUID()
    const created = Math.floor(Date.now() / 1000)
    const outputItem = {
      id: 'msg_' + randomUUID(),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: successText, annotations: [] }],
    }
    const usage = {
      input_tokens: 10,
      output_tokens: 10,
      total_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    }
    const responseObject = {
      id,
      object: 'response',
      created_at: created,
      model: body.model,
      status: 'completed',
      output: [outputItem],
      usage,
    }
    if (!body.stream) {
      call.finished = true
      return respond(
        response,
        isResponses
          ? responseObject
          : {
              id,
              object: 'chat.completion',
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: successText },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 10,
                total_tokens: 20,
              },
            },
      )
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
    })
    let sequence = 0
    const event = (type, value) => {
      if (response.destroyed) return
      response.write(
        `${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(type ? { type, sequence_number: sequence++, ...value } : value)}\n\n`,
      )
    }
    if (isResponses) {
      event('response.created', {
        response: {
          ...responseObject,
          status: 'in_progress',
          output: [],
          usage: null,
        },
      })
      event('response.output_item.added', {
        output_index: 0,
        item: { ...outputItem, status: 'in_progress', content: [] },
      })
      event('response.content_part.added', {
        item_id: outputItem.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
    }
    for (
      let index = 0;
      index < successText.length && !response.destroyed;
      index += 2
    ) {
      const text = successText.slice(index, index + 2)
      if (isResponses)
        event('response.output_text.delta', {
          item_id: outputItem.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        })
      else
        event(null, {
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: text },
              finish_reason: null,
            },
          ],
        })
      await delay(selected === 'slow_success' ? responseChunkDelayMs : 0)
    }
    if (response.destroyed) {
      call.clientClosed = true
      return
    }
    if (isResponses) {
      event('response.output_text.done', {
        item_id: outputItem.id,
        output_index: 0,
        content_index: 0,
        text: successText,
      })
      event('response.output_item.done', { output_index: 0, item: outputItem })
      event('response.completed', { response: responseObject })
    } else {
      event(null, {
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
      response.write('data: [DONE]\n\n')
    }
    call.finished = true
    response.end()
    return
  }
  call.protocol = 'anthropic-messages'
  const fixture = await startMockLlmServer({
    host: '127.0.0.1',
    sequence: [selected],
    successText,
    chunkSize: 2,
    chunkDelayMs: responseChunkDelayMs,
    toolName,
    toolArguments,
  })
  const upstream = httpRequest(
    new URL('/v1/messages', fixture.baseURL),
    {
      method: request.method,
      headers: { ...request.headers, host: new URL(fixture.baseURL).host },
    },
    (result) => {
      response.writeHead(result.statusCode, result.headers)
      // The pinned fixture emits data-only SSE. The official Anthropic SDK
      // requires the matching event field, unlike the older desktop adapter.
      let pending = ''
      const namedEvents = new Transform({
        transform(chunk, _encoding, callback) {
          pending += chunk.toString()
          let boundary
          while ((boundary = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, boundary)
            pending = pending.slice(boundary + 2)
            const data = frame
              .split('\n')
              .find((line) => line.startsWith('data: '))
            const type = data ? JSON.parse(data.slice(6)).type : undefined
            this.push(`${type ? `event: ${type}\n` : ''}${frame}\n\n`)
          }
          callback()
        },
        flush(callback) {
          if (pending) this.push(pending)
          callback()
        },
      })
      result.pipe(namedEvents).pipe(response)
      result.once('end', () => {
        call.finished = true
      })
    },
  )
  upstream.once('error', () => {
    if (!response.headersSent) response.writeHead(502)
    response.end()
  })
  response.once('close', () => {
    call.clientClosed = !call.finished
    upstream.destroy()
    void fixture.close()
  })
  upstream.end(bytes)
}).listen(8080, '0.0.0.0')
