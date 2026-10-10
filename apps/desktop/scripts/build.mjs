/** Assemble already-built UI/Core artifacts into the stable desktop package identity. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(root, 'lib')
if (
  existsSync(output) &&
  (lstatSync(output).isSymbolicLink() ||
    dirname(realpathSync(output)) !== realpathSync(root))
) {
  throw new Error(
    'Refusing to clean an output directory outside the desktop package',
  )
}
const ui = join(root, 'ui')
const core = join(root, 'core')
const required = [
  join(ui, 'dist/index.html'),
  join(ui, 'dist/compatibility.html'),
  join(ui, 'native-ui/index.html'),
  join(ui, 'client/superdsh-desktop/client.js'),
  join(core, 'lib/main/main.js'),
  join(core, 'lib/preload/preload-app.cjs'),
  join(core, 'lib/preload/preload-shell.cjs'),
  join(core, 'lib/preload/preload-extension.cjs'),
]
for (const file of required)
  if (!existsSync(file))
    throw new Error(`Build the desktop workspaces first: missing ${file}`)
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
const entries = [
  'index',
  'main',
  'recovery',
  'browser-guests',
  'permissions',
  'desktop-cli',
  'plugin-cli',
  'desktop-runtime',
  'profiles',
  'extensions',
  'webserver',
  'host-process',
  'web-document',
]
for (const name of entries) {
  const statement =
    name === 'main'
      ? `import '@superdsh/core/main/main'`
      : `export * from '@superdsh/core/main/${name}'`
  writeFileSync(join(output, `${name}.js`), statement + '\n')
  if (name === 'webserver')
    writeFileSync(
      join(output, `${name}.js`),
      statement + "\nexport { default } from '@superdsh/core/main/webserver'\n",
    )
}
writeFileSync(join(output, 'host.js'), "import '@superdsh/core/backend/host'\n")
for (const name of ['preload-app', 'preload-shell', 'preload-extension']) {
  const source = join(core, `lib/preload/${name}.cjs`)
  cpSync(source, join(output, `${name}.cjs`))
}
cpSync(join(ui, 'native-ui'), join(output, 'native-ui'), { recursive: true })
cpSync(join(ui, 'client/superdsh-desktop/client.js'), join(output, 'client.js'))
console.log(
  'SuperDsh assembled: product UI, Core, isolated extension renderer and fixed Harness plugin.',
)
