/** Non-secret installation metadata survives Chromium credential-key changes. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  atomicJson,
  atomicText,
  privateDirectory,
  readPrivateFile,
} from '../backend/private-files.ts'
import type {
  PlatformAccount,
  PlatformSecretStore,
} from './platform-account.ts'

export interface ConnectorBinding {
  installationId: string
  connectorId?: string
  connectorToken?: string
}
interface BindingOptions {
  account: PlatformAccount
  secrets: PlatformSecretStore
  key: string
  directory: string
  diagnostic?(message: string): void
}
function binding(value: unknown, includeToken: boolean): ConnectorBinding {
  if (!value || typeof value !== 'object')
    throw new Error('本机安装记录无效，请检查本地连接数据。')
  const fields = value as Record<string, unknown>
  if (
    typeof fields.installationId !== 'string' ||
    !fields.installationId ||
    fields.installationId.length > 128 ||
    (fields.connectorId !== undefined &&
      (typeof fields.connectorId !== 'string' ||
        !fields.connectorId ||
        fields.connectorId.length > 256)) ||
    (includeToken &&
      fields.connectorToken !== undefined &&
      (typeof fields.connectorToken !== 'string' ||
        !fields.connectorToken ||
        fields.connectorToken.length > 8192))
  )
    throw new Error('本机安装记录无效，请检查本地连接数据。')
  return {
    installationId: fields.installationId,
    ...(typeof fields.connectorId === 'string'
      ? { connectorId: fields.connectorId }
      : {}),
    ...(includeToken && typeof fields.connectorToken === 'string'
      ? { connectorToken: fields.connectorToken }
      : {}),
  }
}
function decrypt(raw: string, secrets: PlatformSecretStore): ConnectorBinding {
  const envelope = JSON.parse(raw) as { encrypted?: unknown }
  if (typeof envelope.encrypted !== 'string')
    throw new Error('本机连接凭据格式无效')
  return binding(
    JSON.parse(
      secrets.decryptString(Buffer.from(envelope.encrypted, 'base64')),
    ),
    true,
  )
}
export function saveConnectorBinding(
  directory: string,
  secrets: PlatformSecretStore,
  value: ConnectorBinding,
): void {
  privateDirectory(directory)
  // This file deliberately contains no token, account name or hostname.
  atomicJson(join(directory, 'installation.json'), binding(value, false))
  atomicJson(join(directory, 'binding.enc.json'), {
    encrypted: secrets.encryptString(JSON.stringify(value)).toString('base64'),
  })
}
export async function readConnectorBinding(
  options: BindingOptions,
): Promise<ConnectorBinding> {
  privateDirectory(options.directory)
  const metadata = readPrivateFile(join(options.directory, 'installation.json'))
  const recover = () =>
    metadata === undefined ? undefined : binding(JSON.parse(metadata), false)
  const current = join(options.directory, 'binding.enc.json')
  const raw = readPrivateFile(current)
  if (raw !== undefined) {
    try {
      return decrypt(raw, options.secrets)
    } catch {
      // Keep the original encrypted bytes before replacing the active binding.
      atomicText(
        join(
          options.directory,
          'binding.unreadable-' + randomUUID() + '.enc.json',
        ),
        raw,
      )
      options.diagnostic?.(
        '本机旧连接凭据无法解密，已保留加密备份；正在恢复当前安装绑定。',
      )
      return recover() ?? { installationId: randomUUID() }
    }
  }
  const recovered = recover()
  if (recovered) return recovered
  const legacy = readPrivateFile(
    join(
      options.account.spaces.homeFor(options.key),
      'platform-connector',
      'binding.enc.json',
    ),
  )
  if (legacy !== undefined) {
    let previous: ConnectorBinding
    try {
      previous = decrypt(legacy, options.secrets)
    } catch {
      options.diagnostic?.(
        '旧账号空间连接凭据无法解密，原文件保留；将为当前本机建立新的稳定安装绑定。',
      )
      return { installationId: randomUUID() }
    }
    if (!previous.connectorId)
      throw new Error('旧设备绑定记录无效，请检查数据后重试。')
    const current = (await options.account.json(
      '/connectors/' + encodeURIComponent(previous.connectorId),
    )) as { connector: { userId: string; blockedAt?: string | null } }
    if (current.connector.userId !== options.account.user.userId)
      throw new Error('旧设备绑定不属于当前账号，不能复用。')
    if (current.connector.blockedAt) throw new Error('此设备已被管理员停用。')
    return previous
  }
  return { installationId: randomUUID() }
}
