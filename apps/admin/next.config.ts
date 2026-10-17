import type { NextConfig } from 'next'

const apiTarget = process.env.AGENTS_ANYWHERE_API ?? 'http://127.0.0.1:8000'
const apiNamespace = process.env.AGENTS_ANYWHERE_API_NAMESPACE ?? '/api/v2'
const proxyClientMaxBodySize = 100 * 1024 * 1024
const staticExport = process.env.NEXT_OUTPUT === 'export'
const nativePlatform = process.env.SUPERDSH_NATIVE_PLATFORM === '1'
const browserApiTarget = staticExport || nativePlatform ? '' : apiTarget
const apiRoutePrefixes = [
  '/admin',
  '/agents',
  '/auth',
  '/connector',
  '/connectors',
  '/health',
  '/oauth',
  '/pairing',
  '/sessions',
  '/.well-known',
]

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  devIndicators: false,
  allowedDevOrigins: ['**.*', 'localhost', '*.localhost'],
  output: staticExport ? 'export' : undefined,
  trailingSlash: staticExport,
  env: {
    NEXT_PUBLIC_AGENTS_ANYWHERE_API: browserApiTarget,
    NEXT_PUBLIC_AGENTS_ANYWHERE_API_NAMESPACE: apiNamespace,
  },
  experimental: {
    // Full timeline sync uses HTTP ingest through this same-origin proxy.
    proxyClientMaxBodySize,
    ...(process.env.SUPERDSH_LOW_MEMORY_BUILD === '1' ? { cpus: 1 } : {}),
  },
  ...(staticExport || nativePlatform
    ? {}
    : {
        async rewrites() {
          const namespace = normalizeApiNamespace(apiNamespace)
          if (namespace) {
            const source = `${namespace}/:path*`
            return [{ source, destination: `${apiTarget}${source}` }]
          }
          return apiRoutePrefixes.map((prefix) => ({
            source: `${prefix}/:path*`,
            destination: `${apiTarget}${prefix}/:path*`,
          }))
        },
      }),
}

function normalizeApiNamespace(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') return ''
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

export default nextConfig
