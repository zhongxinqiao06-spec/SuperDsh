import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

/** 低内存组件验证：加载冻结旧源码，认证上下文使用合成身份，其余资源组件/API/状态保持真实实现。
 * 这里只形成当前资源与技能组件证据，不声称替代完整 Next 页面或当前 Tailwind 构建。
 */
const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)
const legacy = resolve(
  repository,
  '.superdsh-work/web-admin-validation/phase-three-ui/legacy',
)
const output = resolve(
  process.env.WEB_ADMIN_UI_OUTPUT ??
    resolve(
      repository,
      '.superdsh-work/web-admin-validation/phase-three-ui/current-source-components',
    ),
)
const runtime = resolve(output, 'runtime')
await mkdir(runtime, { recursive: true })
const sources = await Promise.all(
  ['agent-resource-manager.tsx', 'skill-program-editor.tsx'].map(
    async (name) => {
      const source = await readFile(
        resolve(legacy, 'src/components/management', name),
      )
      return { name, sha256: createHash('sha256').update(source).digest('hex') }
    },
  ),
)
const fixture = JSON.parse(
  await readFile(
    resolve(
      repository,
      'apps/web-admin/tests/fixtures/baselines/permissions.json',
    ),
    'utf8',
  ),
) as { permissions: Record<string, string> }
const styleRoot = resolve(legacy, '.next-production/static')
const styles = (await readdir(styleRoot, { recursive: true }))
  .filter((name) => name.endsWith('.css'))
  .map((name) => `/@fs/${resolve(styleRoot, name).replaceAll('\\', '/')}`)
await writeFile(
  resolve(runtime, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>冻结旧资源组件验证</title>${styles.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}</head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`,
)
await writeFile(
  resolve(runtime, 'auth-fixture.js'),
  `import { useSyncExternalStore } from 'react'
import { loadStoredSession, subscribeSession } from '@/features/auth/session'
export function useAuth() {
  const session = useSyncExternalStore(subscribeSession, loadStoredSession, () => null)
  return { session, can: (permission) => session?.permissions?.includes(permission) ?? false }
}
`,
)
await writeFile(
  resolve(runtime, 'main.js'),
  `import React from 'react'
import { createRoot } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import messages from '/@fs/${resolve(legacy, 'messages/zh-CN.json').replaceAll('\\', '/')}'
import { saveStoredSession } from '@/features/auth/session'
import { AgentResourceManager } from '@/components/management/agent-resource-manager'
saveStoredSession({ userId: 'parity-admin', role: 'admin', roles: ['admin'], authzVersion: 1, accessToken: 'synthetic-access-token', permissions: ${JSON.stringify(Object.keys(fixture.permissions))} })
const kind = location.hash.includes('knowledge') ? 'knowledge' : location.hash.includes('tools') ? 'tools' : 'skills'
createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'zh-CN', timeZone: 'Asia/Shanghai', messages }, React.createElement('main', { className: 'mx-auto max-w-6xl p-6' }, React.createElement(AgentResourceManager, { kind }))))
`,
)
await writeFile(
  resolve(output, 'provenance.json'),
  JSON.stringify(
    {
      evidenceKind: 'current-frozen-source-components-synthetic-auth-http',
      sources,
      stylesheetSource:
        'Existing old production build CSS; not a fresh Tailwind build',
      excluded: [
        'Full Next router/authentication shell',
        'Full page CSS source rebuild',
        'Real database and model execution',
      ],
      fullParity: false,
    },
    null,
    2,
  ),
)
const server = await createServer({
  configFile: false,
  root: runtime,
  cacheDir: resolve(output, 'vite-cache'),
  resolve: {
    alias: [
      {
        find: '@/components/auth/auth-context',
        replacement: resolve(runtime, 'auth-fixture.js'),
      },
      {
        find: '@superdsh/core/client/skill-presets',
        replacement: resolve(
          repository,
          'apps/desktop/core/src/client/skill-presets.ts',
        ),
      },
      { find: '@', replacement: resolve(legacy, 'src') },
      {
        find: 'next-intl',
        replacement: resolve(legacy, 'node_modules/next-intl'),
      },
      {
        find: 'react-dom',
        replacement: resolve(legacy, 'node_modules/react-dom'),
      },
      { find: 'react', replacement: resolve(legacy, 'node_modules/react') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  define: {
    'process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API': JSON.stringify(''),
    'process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API_NAMESPACE':
      JSON.stringify('/api/v2'),
  },
  server: {
    host: 'localhost',
    port: 5191,
    strictPort: true,
    fs: { allow: [repository] },
  },
})
await server.listen()
server.printUrls()
let closing = false
async function close(): Promise<void> {
  if (closing) return
  closing = true
  await server.close()
  process.exit(0)
}
process.once('SIGINT', () => {
  void close()
})
process.once('SIGTERM', () => {
  void close()
})
