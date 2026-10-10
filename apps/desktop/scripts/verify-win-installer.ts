import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPortableExecutable } from './packaging/verify-win-installer.ts'
const root = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assertPortableExecutable(
  join(root, 'dist', `SuperDsh-${version}-x64-Setup.exe`),
  'SuperDsh NSIS installer',
)
assertPortableExecutable(
  join(root, 'dist', 'win-unpacked', 'SuperDsh.exe'),
  'SuperDsh application',
)
