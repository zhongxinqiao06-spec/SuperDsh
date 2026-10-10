import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { InlineConfig } from 'vite'
import { ownedSourcePlugin } from './source-ownership.mjs'

/** Utility windows share product components, but can boot with no running engine. */
export function createNativeConfig(
  root: string,
  manifest: object,
  inputs: Set<string>,
): InlineConfig {
  return {
    configFile: false,
    root: resolve(root, 'src/app/native'),
    base: './',
    logLevel: 'warn',
    plugins: [
      ownedSourcePlugin(root, manifest, inputs),
      react(),
      tailwindcss(),
    ],
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: Object.entries(
        (manifest as { exports: Record<string, string> }).exports,
      )
        .sort(([a], [b]) => b.length - a.length)
        .map(([find, file]) => ({ find, replacement: resolve(root, file) })),
    },
    build: {
      outDir: resolve(root, 'native-ui'),
      emptyOutDir: true,
      assetsInlineLimit: 0,
    },
  }
}
