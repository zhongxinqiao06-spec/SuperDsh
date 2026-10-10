import { defineConfig } from 'tsdown'
import { resolve } from 'node:path'

const PACKAGE_NAME = 'dsh-community-market'

export default defineConfig({
  name: `${PACKAGE_NAME}/client`,
  entry: {
    client: '../apps/desktop/ui/src/features/community-market/index.ts',
  },
  tsconfig: 'tsconfig.client.json',
  alias: {
    '@superdsh/core/contracts/community-market/media-ref': resolve(
      import.meta.dirname,
      '../apps/desktop/core/src/contracts/community-market/media-ref.ts',
    ),
  },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-locale/client',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-layout/client',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-settings/client',
    '@deepseek-ai/dsh-client-ui-sidebar/client',
    '@deepseek-ai/dsh-client-ui-slots',
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
