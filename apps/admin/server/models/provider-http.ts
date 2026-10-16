import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { ApiError } from '../http/api-router.ts'

export type AddressResolver = (hostname: string) => Promise<string[]>
const nonPublic = new BlockList()
const nonPublicV6 = new BlockList()
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  nonPublic.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  nonPublicV6.addSubnet(network, prefix, 'ipv6')

export function publicAddress(address: string): boolean {
  const family = isIP(address)
  if (!family || address.includes('%')) return false
  if (family === 6 && address.toLowerCase().startsWith('::ffff:')) {
    const mapped = address.slice(7)
    if (isIP(mapped) === 4) return publicAddress(mapped)
    // Hex-mapped IPv4 remains private by default; no ambiguous normalization.
    return false
  }
  return family === 4
    ? !nonPublic.check(address, 'ipv4')
    : globalV6.check(address, 'ipv6') && !nonPublicV6.check(address, 'ipv6')
}
function validUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ApiError(422, 'personal model address is invalid')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ApiError(422, 'personal model address is invalid')
  return url
}
export async function resolveProviderAddress(
  value: string,
  allowedOrigins: string,
  resolver: AddressResolver = async (hostname) =>
    (await lookup(hostname, { all: true })).map((entry) => entry.address),
): Promise<{ url: URL; address: string; family: number }> {
  const url = validUrl(value)
  const allowed = new Set<string>()
  for (const entry of allowedOrigins
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const origin = validUrl(entry)
    if (origin.pathname !== '/')
      throw new ApiError(422, 'personal model network allowlist is invalid')
    allowed.add(origin.origin)
  }
  let addresses: string[]
  let timer: NodeJS.Timeout | undefined
  try {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    addresses = isIP(host)
      ? [host]
      : await Promise.race([
          resolver(host),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('DNS timeout')), 5000)
          }),
        ])
  } catch {
    throw new ApiError(422, 'personal model address cannot be resolved')
  } finally {
    clearTimeout(timer)
  }
  if (!addresses.length || addresses.some((address) => !isIP(address)))
    throw new ApiError(422, 'personal model address cannot be resolved')
  if (
    !allowed.has(url.origin) &&
    addresses.some((address) => !publicAddress(address))
  )
    throw new ApiError(
      422,
      'personal model address must resolve only to public addresses; self-hosted endpoints require an administrator origin allowlist',
    )
  return { url, address: addresses[0]!, family: isIP(addresses[0]!) }
}

/** One connection to a prevalidated literal address. Host and TLS SNI retain the configured authority. No redirects, ambient proxy, or automatic generation retry. */
export async function providerRequest(options: {
  url: string
  method: string
  headers: Record<string, string>
  body?: Buffer
  personal: boolean
  allowedOrigins: string
  signal: AbortSignal
  resolver?: AddressResolver
}): Promise<IncomingMessage> {
  const pin = options.personal
    ? await resolveProviderAddress(
        options.url,
        options.allowedOrigins,
        options.resolver,
      )
    : null
  const url = pin?.url ?? validUrl(options.url)
  options.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: pin?.address ?? url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        servername: url.hostname.replace(/^\[|\]$/g, ''),
        path: url.pathname,
        method: options.method,
        headers: {
          ...options.headers,
          Host: url.host,
          ...(options.body
            ? { 'Content-Length': String(options.body.length) }
            : {}),
        },
        signal: options.signal,
        agent: false,
      },
      resolve,
    )
    request.setTimeout(300_000, () =>
      request.destroy(new Error('Model request timeout')),
    )
    request.once('error', () =>
      reject(new ApiError(502, 'model provider connection failed')),
    )
    request.end(options.body)
  })
}
