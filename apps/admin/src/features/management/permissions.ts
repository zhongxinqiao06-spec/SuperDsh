export const MANAGEMENT_PERMISSIONS = [
  'users.read',
  'roles.manage',
  'devices.inventory.read',
  'models.manage',
  'audit.read',
] as const

export function canManagePlatform(
  permissions: readonly string[] | undefined,
): boolean {
  return MANAGEMENT_PERMISSIONS.some((permission) =>
    permissions?.includes(permission),
  )
}
