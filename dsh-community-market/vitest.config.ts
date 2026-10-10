import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom', '@deepseek-ai/cordis'],
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives':
        require.resolve('@deepseek-ai/dsh-client-ui-primitives'),
      '@deepseek-ai/dsh-client-store':
        require.resolve('@deepseek-ai/dsh-client-store'),
      '@deepseek-ai/dsh-storage-domain':
        require.resolve('@deepseek-ai/dsh-storage-domain'),
      '@superdsh/core/contracts/community-market/media-ref': resolve(
        import.meta.dirname,
        '../apps/desktop/core/src/contracts/community-market/media-ref.ts',
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
    setupFiles: ['./tests/setup.tsx'],
  },
})
