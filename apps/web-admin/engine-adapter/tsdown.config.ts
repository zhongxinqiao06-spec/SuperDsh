import { fileURLToPath } from 'node:url'

export default {
  entry: {
    host: fileURLToPath(new URL('./src/host.ts', import.meta.url)),
    'preset-plugin': fileURLToPath(
      new URL('./src/preset-plugin.ts', import.meta.url),
    ),
  },
  outDir: fileURLToPath(new URL('./dist', import.meta.url)),
  format: 'esm',
  platform: 'node',
  target: 'node24',
  clean: true,
  dts: false,
  outExtensions: () => ({ js: '.mjs' }),
}
