import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/gu
const DESKTOP_MODULE =
  /(?:^|\/)(?:dsh-plugin-desktop(?:-beta)?|dsh-desktop-next|@superdsh\/(?:desktop|core|ui|harness)|apps\/desktop)(?:\/|$)/u

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

export function verifyMarketDependencyDirection(files) {
  const violations = []
  for (const [path, source] of files) {
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? ''
      const normalized = normalizePath(specifier)
      const target = normalized.startsWith('.')
        ? posix.normalize(
            posix.join(posix.dirname(normalizePath(path)), normalized),
          )
        : normalized
      const marketSource =
        /^apps\/desktop\/(?:ui\/src\/features\/community-market|core\/src\/(?:contracts|services)\/community-market)(?:\/|$)/u.test(
          target,
        )
      const marketContract =
        /^@superdsh\/core\/contracts\/community-market(?:\/|$)/u.test(
          normalized,
        )
      if (DESKTOP_MODULE.test(target) && !marketSource && !marketContract) {
        violations.push(normalizePath(path))
        break
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Market source must not import Desktop implementation: ${violations.join(', ')}`,
    )
  }
  return { fileCount: files.length }
}

export function verifyTrackedMarketDependencyDirection(root) {
  const paths = [
    ...new Set(
      execFileSync(
        'git',
        [
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
          '--',
          'dsh-community-market/src',
          'apps/desktop/ui/src/features/community-market',
          'apps/desktop/core/src/services/community-market',
          'apps/desktop/core/src/contracts/community-market',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
        .split('\0')
        .filter(
          (path) =>
            /\.[cm]?[jt]sx?$/u.test(path) && existsSync(resolve(root, path)),
        )
        .map(normalizePath),
    ),
  ]
  if (!paths.length)
    throw new Error(
      'Market dependency direction check found no implementation files',
    )
  return verifyMarketDependencyDirection(
    paths.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]),
  )
}
