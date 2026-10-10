// Regenerate the one version-pinned runtime patch without editing an installation.
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const root = fileURLToPath(new URL('..', import.meta.url))
const repo = resolve(root, '../../..')
const archive = join(
  repo,
  'vendor/dsh-runtime/0.1.7-alpha.2/deepseek-ai-dsh-client-modules-0.1.7-alpha.2.tgz',
)
const original = execFileSync(
  'tar',
  ['-xOf', archive, 'package/lib/index.js'],
  { encoding: 'utf8' },
)
const helper = `
/** Product-owned browser artifacts; Host faces and unknown plugins keep their original resolution. */
export const superdshClientArtifactManifestVersion = 1;
function readClientArtifactManifest(file) {
  if (file === void 0) return new Map();
  if (typeof file !== "string" || !isAbsolute(file)) throw new Error("client-modules: clientArtifactManifest must be an absolute path");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (manifest === null || typeof manifest !== "object" || manifest.schemaVersion !== 1 || manifest.harnessVersion !== "0.1.7-alpha.2" || manifest.modules === null || typeof manifest.modules !== "object" || Array.isArray(manifest.modules)) throw new Error("client-modules: incompatible product client artifact manifest");
  const entries = new Map();
  for (const [id, row] of Object.entries(manifest.modules)) {
    if (row === null || typeof row !== "object" || typeof row.path !== "string" || !row.path || isAbsolute(row.path)) throw new Error("client-modules: invalid product client artifact for " + id);
    const clientPath = resolve(dirname(file), row.path);
    const local = relative(dirname(file), clientPath);
    if (local === ".." || local.startsWith("../") || local.startsWith("..\\\\") || isAbsolute(local)) throw new Error("client-modules: product client artifact escapes its manifest directory: " + id);
    if (!statSync(clientPath).isFile()) throw new Error("client-modules: product client artifact is not a file: " + id);
    const declaration = parseDshClient(id, { platform: "web", inject: row.inject, external: row.external, immediately: row.immediately });
    entries.set(id, { clientPath, ...(declaration.inject !== void 0 ? { inject: declaration.inject } : {}), external: declaration.external ?? [], immediately: declaration.immediately === true });
  }
  return entries;
}
`
let patched = original.replace(
  'import { dirname, isAbsolute, join } from "node:path";',
  'import { dirname, isAbsolute, join, relative, resolve } from "node:path";',
)
// Preserve the existing desktop patch's linear native string search for large source maps.
patched = patched.replace(
  'for (const char of value) if (char === "\\n") count += 1;',
  'for (let offset = value.indexOf("\\n"); offset !== -1; offset = value.indexOf("\\n", offset + 1)) count += 1;',
)
patched = patched.replace(
  'var ClientModuleRegistry = class extends Service {',
  helper +
    '\nvar ClientModuleRegistry = class extends Service {\n\tclientArtifactModules;',
)
patched = patched.replace(
  'constructor(ctx) {\n\t\tsuper(ctx, "clientModules");',
  'constructor(ctx, config = {}) {\n\t\tsuper(ctx, "clientModules");\n\t\tthis.clientArtifactModules = readClientArtifactManifest(config.clientArtifactManifest);',
)
patched = patched.replace(
  'meta: {\n\t\t\t\tclientPath: join(dirname(pkgPath), clientRel),',
  'meta: this.clientArtifactModules.get(packageName) ?? {\n\t\t\t\tclientPath: join(dirname(pkgPath), clientRel),',
)
if (
  patched === original ||
  !patched.includes('this.clientArtifactModules = readClientArtifactManifest')
)
  throw new Error('Runtime patch anchors drifted')
const scratch = join(root, '.patch-build')
mkdirSync(scratch, { recursive: true })
try {
  writeFileSync(join(scratch, 'before.js'), original)
  writeFileSync(join(scratch, 'after.js'), patched)
  let diff
  try {
    diff = execFileSync(
      'git',
      [
        'diff',
        '--no-index',
        '--',
        join(scratch, 'before.js'),
        join(scratch, 'after.js'),
      ],
      { encoding: 'utf8' },
    )
  } catch (error) {
    if (error.status !== 1) throw error
    diff = error.stdout
  }
  diff = diff
    .replace(/^diff --git .*$/m, 'diff --git a/lib/index.js b/lib/index.js')
    .replace(/^--- .*$/m, '--- a/lib/index.js')
    .replace(/^\+\+\+ .*$/m, '+++ b/lib/index.js')
  writeFileSync(join(repo, 'patches/superdsh-client-modules.patch'), diff)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log('Wrote version-pinned client-modules artifact override patch')
