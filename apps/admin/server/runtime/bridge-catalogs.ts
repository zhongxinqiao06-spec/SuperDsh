import { ApiError } from '../http/api-router.ts'
import type { RuntimeNotification } from './bridge-client.ts'

type Fields = Record<string, unknown>
export type BridgeCatalogKind = 'model' | 'permission'

function fields(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(502, 'Harness returned an invalid catalog object')
  return value as Fields
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new ApiError(502, `Harness catalog is missing ${name}`)
  return value
}

function entries(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new ApiError(502, 'Harness returned an invalid catalog list')
  return value
}

function item(value: unknown): Fields {
  const raw = fields(value)
  if (typeof raw.enabled !== 'boolean')
    throw new ApiError(502, 'Harness catalog has an invalid enabled flag')
  return {
    id: required(raw.id, 'id'),
    displayName: required(raw.title, 'title'),
    selectionId: required(raw.selectionId, 'selectionId'),
    description: typeof raw.description === 'string' ? raw.description : null,
    // DSH deliberately does not expose remembered model/permission defaults.
    // Product defaults are selected separately by the account's model catalog.
    default: false,
    metadata: {
      ...(raw.metadata === undefined ? {} : fields(raw.metadata)),
      enabled: raw.enabled,
      ...(typeof raw.disabledReason === 'string'
        ? { disabledReason: raw.disabledReason }
        : {}),
    },
  }
}

/** DSH Bridge 1.0 uses title/enabled; public AA 1.0 uses displayName/metadata. */
export function bridgeCatalog(kind: BridgeCatalogKind, value: unknown): Fields {
  const raw = fields(value)
  if (
    raw.runtime !== 'dsh' ||
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 0
  )
    throw new ApiError(502, 'Harness returned an invalid catalog revision')
  const result: Fields = {
    runtime: 'dsh',
    runtimeId: 'dsh',
    revision: raw.revision,
    ...(raw.metadata === undefined ? {} : { metadata: fields(raw.metadata) }),
  }
  if (kind === 'model')
    result.models = entries(raw.models).map((value) => {
      const model = fields(value)
      return {
        ...item(model),
        reasoningItems: entries(model.reasoningItems ?? []).map((value) => {
          const reasoning = fields(value)
          return {
            ...item(reasoning),
            fullModelId:
              typeof reasoning.fullModelId === 'string'
                ? reasoning.fullModelId
                : null,
          }
        }),
      }
    })
  else result.permissions = entries(raw.permissions).map(item)
  return result
}

/** Apply the same boundary to initial catalogs and durable sync notifications. */
export function bridgeCatalogNotification(
  event: RuntimeNotification,
): RuntimeNotification {
  const kind =
    event.method === 'catalog.model.update'
      ? 'model'
      : event.method === 'catalog.permission.update'
        ? 'permission'
        : event.method === 'runtime.catalog.updated' &&
            (event.params.catalogType === 'model' ||
              event.params.catalogType === 'permission')
          ? event.params.catalogType
          : null
  if (!kind) return event
  const wrapped = event.params.catalog !== undefined
  const catalog = bridgeCatalog(
    kind,
    wrapped ? event.params.catalog : event.params,
  )
  return {
    ...event,
    params: {
      ...event.params,
      ...(wrapped ? { catalog } : catalog),
    },
  }
}
