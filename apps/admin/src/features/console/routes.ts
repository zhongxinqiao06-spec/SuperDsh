import { canOpenModule, consoleModules } from './modules'

const aliases: Record<string, string> = {
  '': '#/overview',
  '#': '#/overview',
  '#/': '#/overview',
  '#/app': '#/overview',
  '#/dashboard': '#/overview',
  '#/team': '#/access/users',
  '#/management': '#/management',
  '#/service': '#/system/service',
  '#/settings': '#/account/profile',
  '#/settings/account': '#/account/profile',
  '#/settings/appearance': '#/account/appearance',
  '#/settings/personal-models': '#/account/models',
  '#/settings/mobile-connections': '#/account/mobile',
  '#/settings/archived-sessions': '#/workspace/archived',
  '#/mobile-connections': '#/account/mobile',
}

/** Only known internal destinations may survive login; never accept a URL. */
export function consoleHash(hash: string): string | null {
  if (hash.length > 8192 || (hash && !hash.startsWith('#'))) return null
  const normalized = hash.replace(/^#(?!\/|$)/, '#/')
  if (Object.hasOwn(aliases, normalized)) return aliases[normalized]!
  if (consoleModules.some((module) => module.route === normalized))
    return normalized
  if (/^#\/(session|device|new-session)\/[^/?#]+$/.test(normalized))
    return normalized.replace('#/', '#/workspace/')
  if (
    /^#\/workspace\/(session|device|new-session)\/[^/?#]+$/.test(normalized) ||
    normalized === '#/workspace/archived'
  )
    return normalized
  return null
}

export function resolveConsoleRoute(
  hash: string,
  permissions: readonly string[] = [],
) {
  let canonical = consoleHash(hash)
  if (canonical === '#/management') {
    canonical =
      consoleModules.find(
        (module) =>
          [
            'access.users',
            'access.roles',
            'access.menus',
            'devices',
            'models',
            'system.audit',
          ].includes(module.id) && canOpenModule(module, permissions),
      )?.route ?? '#/access/users'
  }
  const module = consoleModules.find(
    (module) =>
      module.route === canonical ||
      (module.id === 'workbench' && canonical?.startsWith('#/workspace/')),
  )
  return { hash: canonical ?? hash, moduleId: module?.id ?? null }
}
