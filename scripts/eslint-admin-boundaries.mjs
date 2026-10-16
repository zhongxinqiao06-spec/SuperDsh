import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const adminRoot = resolve(import.meta.dirname, '../apps/admin')
const backendRoot = resolve(adminRoot, 'server')
const backendPackages = new Set([
  'pg',
  'redis',
  'ws',
  'node-pty',
  '@superdsh/harness',
  '@agents-anywhere/dsh-bridge-next',
])

function forbiddenImport(source, filename) {
  if (isBuiltin(source)) return true
  if (source.startsWith('@aws-sdk/')) return true
  if (
    [...backendPackages].some(
      (name) => source === name || source.startsWith(`${name}/`),
    )
  )
    return true
  if (/^@superdsh\/admin\/server(?:\/|$)/u.test(source)) return true
  const target = source.startsWith('.')
    ? resolve(dirname(filename), source)
    : source.startsWith('@/')
      ? resolve(adminRoot, 'src', source.slice(2))
      : isAbsolute(source)
        ? resolve(source)
        : null
  if (!target) return false
  const path = relative(backendRoot, target)
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  )
}

export const adminBrowserBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      backend:
        'Browser UI cannot import {{source}}. Call API v2 through the frontend API client; keep Node implementations in apps/admin/server.',
    },
  },
  create(context) {
    function inspect(node) {
      const source =
        node?.type === 'Literal'
          ? node.value
          : node?.type === 'TemplateLiteral' && node.expressions.length === 0
            ? node.quasis[0]?.value.cooked
            : null
      if (
        typeof source === 'string' &&
        forbiddenImport(source, context.filename)
      ) {
        context.report({ node, messageId: 'backend', data: { source } })
      }
    }
    return {
      ImportDeclaration: (node) => inspect(node.source),
      ExportNamedDeclaration: (node) => inspect(node.source),
      ExportAllDeclaration: (node) => inspect(node.source),
      ImportExpression: (node) => inspect(node.source),
      TSImportType: (node) => inspect(node.source),
      TSExternalModuleReference: (node) => inspect(node.expression),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          inspect(node.arguments[0])
      },
    }
  },
}
