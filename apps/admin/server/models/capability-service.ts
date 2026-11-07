import { createHash, randomUUID } from 'node:crypto'
import type { CapabilityBinding } from '@superdsh/core/contracts/platform'
import {
  ApiError,
  object,
  requiredText,
  text,
  utcNow,
  type Account,
} from '../http/api-router.ts'
import type { Database, Row } from '../infrastructure/database.ts'
import type { FileLibrary } from '../files/file-library.ts'
import { detectMediaType } from '../files/file-library.ts'
import type { ModelConfigurationService } from './configuration-service.ts'
import { providerRequest } from './provider-http.ts'
import { validateModelParameters } from './capabilities.ts'
import { imageData } from '../agents/office/image-data.ts'
import { createModelCredentialCipher } from '../identity/model-credentials.ts'
import { visionResponse } from './vision-response.ts'

const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
async function responseBytes(
  response: Awaited<ReturnType<typeof providerRequest>>,
  maximum = 32 * 1024 * 1024,
) {
  const parts: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > maximum) throw new ApiError(413, '供应商响应超过处理上限')
      parts.push(bytes)
    }
    if ((response.statusCode ?? 500) >= 300)
      throw new ApiError(
        502,
        `供应商拒绝请求（HTTP ${response.statusCode}），未切换费用来源`,
      )
    return Buffer.concat(parts)
  } finally {
    response.destroy()
  }
}

export class ModelCapabilityService {
  readonly options: {
    db: Database
    models: ModelConfigurationService
    files: FileLibrary
    getAccount(id: string): Promise<Account>
    authorizeSession(owner: string, session: string): Promise<unknown>
    allowedOrigins?: string
  }
  constructor(options: ModelCapabilityService['options']) {
    this.options = options
  }

  async authorize(owner: string, session: string, binding: CapabilityBinding) {
    await this.options.authorizeSession(owner, session)
    return this.options.models.resolve(
      await this.options.getAccount(owner),
      binding,
    )
  }

  /** A durable receipt precedes network submission. An uncertain receipt is never submitted again. */
  async execute(...args: Parameters<ModelCapabilityService['executeOwned']>) {
    const [owner, session, , key, , , signal] = args
    const lease = await this.options.db.lease(
      'capability:' + hash(owner + ':' + session + ':' + key),
    )
    if (!lease) throw new ApiError(409, '供应商操作正在处理，请稍后查询')
    const controller = new AbortController()
    void lease.lost.then((error) => controller.abort(error))
    try {
      args[6] = AbortSignal.any([signal, controller.signal])
      return await this.executeOwned(...args)
    } finally {
      await lease.release()
    }
  }

  private async executeOwned(
    owner: string,
    session: string,
    binding: CapabilityBinding,
    key: string,
    input: Row,
    images: { content: Buffer; mediaType: string }[],
    signal: AbortSignal,
  ) {
    const resolved = await this.authorize(owner, session, binding)
    const requestHash = hash(
      JSON.stringify({
        binding,
        input,
        images: images.map((image) => hash(image.content)),
      }),
    )
    let operationId = 'operation_' + randomUUID().replaceAll('-', '')
    let receipt: Row | undefined
    const cipher = createModelCredentialCipher(
      this.options.models.options.encryptionKey,
    )
    const inserted = await this.options.db.query(
      `INSERT INTO model_provider_operations(id,owner_user_id,session_id,idempotency_key,configuration_id,configuration_revision,request_hash,state,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'submitting',$8,$8) ON CONFLICT(owner_user_id,session_id,idempotency_key) DO NOTHING RETURNING id`,
      [
        operationId,
        owner,
        session,
        requiredText(key, '执行幂等标识', 200),
        binding.configurationId,
        binding.revision,
        requestHash,
        utcNow(),
      ],
    )
    if (!inserted.length) {
      const [previous] = await this.options.db.query(
        'SELECT * FROM model_provider_operations WHERE owner_user_id=$1 AND session_id=$2 AND idempotency_key=$3',
        [owner, session, key],
      )
      if (previous?.request_hash !== requestHash)
        throw new ApiError(409, '执行标识已用于不同内容')
      if (previous.state === 'completed')
        return JSON.parse(text(previous.result_json)) as Row
      if (previous.receipt_ciphertext) {
        operationId = text(previous.id)
        receipt = object(
          JSON.parse(
            cipher.open(
              text(previous.receipt_ciphertext),
              'provider-operation:' + operationId,
            ),
          ),
        )
      } else
        throw new ApiError(
          409,
          `供应商操作状态：${previous.state}；不会自动重复收费提交`,
          { code: 'provider_operation_pending' },
        )
    }
    await this.options.db.query(
      'UPDATE model_provider_operations SET tool_run_id=(SELECT id FROM agent_tool_runs WHERE id=$2 AND owner_user_id=$3 AND session_id=$4) WHERE id=$1',
      [operationId, key.split(':')[0], owner, session],
    )
    const controller = new AbortController(),
      timeout = AbortSignal.timeout(240_000)
    const combined = AbortSignal.any([signal, controller.signal, timeout])
    let checking = false,
      accepted = false,
      rejected = false,
      resultRejected = false,
      submitted = false
    const timer = setInterval(() => {
      if (checking) return
      checking = true
      void this.authorize(owner, session, binding)
        .catch(() => controller.abort())
        .finally(() => {
          checking = false
        })
    }, 1000)
    timer.unref()
    try {
      const { configuration, connection, key: credential } = resolved
      const prompt = requiredText(input.prompt, '提示词', 20000)
      if (images.length > Number(configuration.parameters.maxImages || 4))
        throw new ApiError(422, '参考图片数量超过模型配置上限')
      const imageInputs = images.map((image) => {
        const mediaType = detectMediaType(
          image.content,
          'reference',
          image.mediaType,
        )
        if (
          !['image/png', 'image/jpeg', 'image/webp'].includes(mediaType) ||
          image.content.length > 10 * 1024 * 1024
        )
          throw new ApiError(
            422,
            '参考图片必须为有效 PNG、JPEG 或 WebP，且不超过 10 MiB',
          )
        return `data:${mediaType};base64,${image.content.toString('base64')}`
      })
      let endpoint: string, body: Row
      if (binding.capability === 'image.generate') {
        const parameters = validateModelParameters(
          connection.adapter,
          binding.capability,
          configuration.modelId,
          {
            ...configuration.parameters,
            ...(input.size ? { size: input.size } : {}),
          },
        )
        if (imageInputs.length && connection.adapter !== 'volcengine-ark')
          throw new ApiError(422, '此适配器尚未声明参考图编辑能力')
        endpoint = '/images/generations'
        body = {
          model: configuration.modelId,
          prompt,
          size: parameters.size,
          response_format: 'b64_json',
          ...(connection.adapter === 'volcengine-ark'
            ? {
                watermark: true,
                ...(imageInputs.length
                  ? {
                      image:
                        imageInputs.length === 1 ? imageInputs[0] : imageInputs,
                    }
                  : {}),
              }
            : { n: 1 }),
        }
      } else if (binding.capability === 'vision.analyze') {
        if (!imageInputs.length)
          throw new ApiError(422, '视觉理解至少需要一张图片')
        if (
          connection.adapter === 'volcengine-ark' ||
          connection.adapter === 'openai-responses'
        ) {
          endpoint = '/responses'
          body = {
            model: configuration.modelId,
            store: false,
            max_output_tokens: configuration.parameters.maxTokens || 4096,
            ...(connection.adapter === 'volcengine-ark' &&
            ['enabled', 'disabled'].includes(
              text(configuration.parameters.thinking),
            )
              ? { thinking: { type: configuration.parameters.thinking } }
              : {}),
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: prompt },
                  ...imageInputs.map((image_url) => ({
                    type: 'input_image',
                    image_url,
                  })),
                ],
              },
            ],
          }
        } else {
          endpoint = '/chat/completions'
          body = {
            model: configuration.modelId,
            max_tokens: configuration.parameters.maxTokens || 4096,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  ...imageInputs.map((url) => ({
                    type: 'image_url',
                    image_url: { url },
                  })),
                ],
              },
            ],
          }
        }
      } else throw new ApiError(422, '此能力尚未实现')
      let value = receipt
      if (!value) {
        const bytes = Buffer.from(JSON.stringify(body))
        if (bytes.length > 32 * 1024 * 1024)
          throw new ApiError(413, '模型输入超过处理上限')
        combined.throwIfAborted()
        submitted = true
        const response = await providerRequest({
          url: connection.baseUrl.replace(/\/+$/, '') + endpoint,
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + credential,
            'Content-Type': 'application/json',
          },
          body: bytes,
          personal: true,
          allowedOrigins: this.options.allowedOrigins || '',
          signal: combined,
        })
        accepted = (response.statusCode ?? 500) < 300
        rejected = !accepted
        const requestId = text(
          response.headers['x-request-id'] || response.headers['x-tt-logid'],
        )
        await this.options.db.query(
          'UPDATE model_provider_operations SET provider_request_id=$2,state=$3,updated_at=$4 WHERE id=$1',
          [
            operationId,
            requestId || null,
            accepted ? 'running' : 'failed',
            utcNow(),
          ],
        )
        value = object(
          JSON.parse((await responseBytes(response)).toString('utf8')),
        )
        // An accepted synchronous result can be transferred again without repeating the paid POST.
        await this.options.db.query(
          "UPDATE model_provider_operations SET receipt_ciphertext=$2,state='result-pending',updated_at=$3 WHERE id=$1",
          [
            operationId,
            cipher.seal(
              JSON.stringify(value),
              'provider-operation:' + operationId,
            ),
            utcNow(),
          ],
        )
        receipt = value
      } else {
        submitted = true
        accepted = true
      }
      const usage =
        value.usage && typeof value.usage === 'object' ? value.usage : {}
      await this.options.db.query(
        'UPDATE model_provider_operations SET usage_json=$2 WHERE id=$1',
        [operationId, JSON.stringify(usage)],
      )
      let result: Row
      if (binding.capability === 'vision.analyze') {
        let answer: string
        try {
          answer = visionResponse(value)
        } catch (error) {
          resultRejected = true
          throw error
        }
        result = { operationId, text: answer, usage }
      } else {
        const item = object(
          Array.isArray(value.data) ? (value.data[0] ?? {}) : {},
        )
        let content: Buffer
        if (typeof item.b64_json === 'string') {
          content = Buffer.from(item.b64_json, 'base64')
          if (content.toString('base64') !== item.b64_json)
            throw new ApiError(502, '供应商图片编码无效')
        } else if (item.url) {
          // No authorization header is forwarded to a vendor's output host; redirects stay disabled.
          content = await responseBytes(
            await providerRequest({
              url: requiredText(item.url, '图片地址'),
              method: 'GET',
              headers: {},
              personal: true,
              allowedOrigins: this.options.allowedOrigins || '',
              signal: combined,
              mediaDownload: true,
            }),
          )
        } else throw new ApiError(502, '供应商未返回图片')
        const mediaType = detectMediaType(content, 'image', '')
        const extension = (
          {
            'image/png': 'png',
            'image/jpeg': 'jpg',
          } as Record<string, string>
        )[mediaType]
        if (!extension) throw new ApiError(502, '供应商返回了不支持的图片格式')
        const filename =
          text(input.title, '生成配图')
            .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
            .slice(0, 100) +
          '.' +
          extension
        imageData({ filename, content })
        await this.authorize(owner, session, binding)
        const fileId = await this.options.files.saveLegacy(
          owner,
          'session',
          session,
          operationId,
          filename,
          content,
          mediaType,
        )
        const file = await this.options.files.entry(owner, fileId)
        result = {
          operationId,
          fileId: file.id,
          name: file.name,
          mediaType,
          sha256: file.sha256,
          size: file.size,
          usage,
          configuration: binding,
        }
      }
      await this.authorize(owner, session, binding)
      await this.options.db.query(
        "UPDATE model_provider_operations SET state='completed',receipt_ciphertext=NULL,result_json=$2,usage_json=$3,updated_at=$4 WHERE id=$1",
        [operationId, JSON.stringify(result), JSON.stringify(usage), utcNow()],
      )
      return result
    } catch (error) {
      const state =
        !submitted || rejected || resultRejected
          ? 'failed'
          : signal.aborted || controller.signal.aborted
            ? 'cancel-requested'
            : timeout.aborted
              ? 'timed-out'
              : receipt
                ? 'result-pending'
                : 'submission-unknown'
      if (state === 'cancel-requested')
        await this.options.db.query(
          'UPDATE model_provider_operations SET cancel_requested_at=$2 WHERE id=$1',
          [operationId, utcNow()],
        )
      await this.options.db.query(
        'UPDATE model_provider_operations SET state=$2,error=$3,updated_at=$4 WHERE id=$1',
        [
          operationId,
          state,
          resultRejected && error instanceof ApiError
            ? error.message
            : !submitted || rejected
              ? '请求失败，未自动重试；请检查配置或供应商诊断'
              : accepted
                ? '供应商已受理，结果尚未保存；请核对请求记录，不要重复提交'
                : '提交结果未确认；未自动重试收费调用',
          utcNow(),
        ],
      )
      if (timeout.aborted)
        throw new ApiError(504, '供应商调用超时，提交状态需要核对；未自动重试')
      throw error
    } finally {
      clearInterval(timer)
    }
  }
}
