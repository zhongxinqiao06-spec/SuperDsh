import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const write = (path, text) => writeFileSync(join(root, path), text)
mkdirSync(join(root, 'lib/contracts'), { recursive: true })
for (const extension of ['js', 'd.ts']) {
  write(
    `lib/index.${extension}`,
    "export * from './services/community-market/index.js'\n",
  )
  write(
    `lib/contracts/index.${extension}`,
    "export * from '../services/community-market/contracts/index.js'\n",
  )
}
mkdirSync(join(root, 'lib/types/client'), { recursive: true })
// The public plugin client contract stays deliberately small. Its complete
// implementation is checked with every other source in @superdsh/ui.
write(
  'lib/types/client/index.d.ts',
  "import type { Context } from '@deepseek-ai/cordis'\nexport declare const inject: string[]\nexport declare const NS = 'community-market'\nexport declare function apply(ctx: Context): void\n",
)
