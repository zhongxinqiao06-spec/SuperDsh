import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import type { InlineConfig } from 'vite'
import { clientBuildEnvironmentDefines } from '../build/harness/client-build-environment.ts'
import { ownedSourcePlugin } from './source-ownership.mjs'
import { PLATFORM_MODULES } from '../src/compatibility/harness/web/platform.ts'

export function createWebConfig(
  root: string,
  manifest: object,
  inputs: Set<string>,
): InlineConfig {
  const primitivesEntry = 'virtual:superdsh-platform-primitives'
  return {
    configFile: false,
    root,
    base: './',
    logLevel: 'warn',
    plugins: [
      ownedSourcePlugin(root, manifest, inputs),
      react(),
      {
        name: 'superdsh-title',
        transformIndexHtml: (html) =>
          html.replace(
            '<title>DSH Local Build</title>',
            '<title>SuperDsh</title>',
          ),
      },
      {
        name: 'superdsh-platform-contract',
        resolveId: (id) =>
          id === primitivesEntry ? '\0' + primitivesEntry : null,
        load: (id) =>
          id === '\0' + primitivesEntry
            ? "export * from '@deepseek-ai/dsh-client-ui-primitives'"
            : null,
        generateBundle(_options, bundle) {
          const exports: Record<string, string[]> = {}
          const aliases = (manifest as { exports: Record<string, string> })
            .exports
          for (const id of PLATFORM_MODULES) {
            if (aliases[id] === undefined) continue
            const absolute = resolve(root, aliases[id])
            const info =
              this.getModuleInfo(absolute) ??
              this.getModuleInfo(absolute.replaceAll('\\', '/'))
            if (info === null)
              throw new Error(
                `Platform module was not built from owned source: ${id}`,
              )
            exports[id] = [...info.exports].sort()
          }
          const primitives = Object.values(bundle).find(
            (item) =>
              item.type === 'chunk' &&
              item.isEntry &&
              item.name === 'platform-primitives',
          )
          if (primitives?.type !== 'chunk')
            throw new Error('Missing compiled platform export contract')
          exports['@deepseek-ai/dsh-client-ui-primitives'] = [
            ...primitives.exports,
          ].sort()
          this.emitFile({
            type: 'asset',
            fileName: 'platform-contract.json',
            source:
              JSON.stringify(
                { schemaVersion: 1, modules: PLATFORM_MODULES, exports },
                null,
                2,
              ) + '\n',
          })
        },
      },
    ],
    resolve: {
      dedupe: ['react', 'react-dom', '@deepseek-ai/cordis'],
      alias: [
        {
          find: /^node:module$/,
          replacement: resolve(root, 'src/node-module-stub.ts'),
        },
        ...Object.entries(
          (manifest as { exports: Record<string, string> }).exports,
        )
          .sort(([a], [b]) => b.length - a.length)
          .map(([find, file]) => ({ find, replacement: resolve(root, file) })),
      ],
    },
    build: {
      outDir: resolve(root, 'dist'),
      target: 'es2022',
      sourcemap: true,
      emptyOutDir: true,
      chunkSizeWarningLimit: 1500,
      rolldownOptions: {
        input: {
          index: resolve(root, 'index.html'),
          compatibility: resolve(root, 'compatibility.html'),
          'platform-primitives': primitivesEntry,
        },
        preserveEntrySignatures: 'strict',
      },
    },
    define: {
      ...clientBuildEnvironmentDefines(process.env),
      'process.versions.node': '"0.0.0"',
      'process.execArgv': '[]',
      'process.env.CORDIS_SHARED': 'undefined',
    },
  }
}
