/** Resolve native files from the shell or the isolated Harness dependency tree. */
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'

export function nativeRuntimePath(
  root: string,
  entry: string,
  allowWorkspaceLinks = false,
): string {
  if (!entry.startsWith('node_modules/'))
    throw new Error(`Invalid native runtime entry: ${entry}`)
  const segments = entry.slice('node_modules/'.length).split('/')
  const name = segments
    .splice(0, segments[0]!.startsWith('@') ? 2 : 1)
    .join('/')
  const tail = segments.join('/')
  const anchors = [join(root, 'package.json')]
  const harness = join(root, 'node_modules/@superdsh/harness/package.json')
  if (existsSync(harness)) anchors.push(realpathSync(harness))
  for (const anchor of anchors) {
    const search = createRequire(anchor).resolve.paths(name) ?? []
    for (const directory of search) {
      const candidate = join(directory, name, tail)
      if (!existsSync(candidate)) continue
      const actual = realpathSync(candidate)
      const within = relative(resolve(root), actual)
      if (
        !allowWorkspaceLinks &&
        (isAbsolute(within) ||
          within === '..' ||
          within.startsWith(`..\\`) ||
          within.startsWith('../'))
      ) {
        throw new Error(
          `Native runtime escapes the packaged application: ${entry}`,
        )
      }
      return actual
    }
  }
  throw new Error(
    `Missing native runtime file: ${entry} (application: ${root})`,
  )
}
