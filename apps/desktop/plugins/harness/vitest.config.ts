import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    server: {
      deps: {
        inline: [
          '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
          '@deepseek-ai/dsh-host-open-in-app',
        ],
      },
    },
  },
})
