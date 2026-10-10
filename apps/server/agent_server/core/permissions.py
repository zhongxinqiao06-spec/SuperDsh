"""The catalog never grants access to another user's content."""

PERMISSIONS = {
    "devices.read": "View own devices",
    "devices.manage": "Manage own devices",
    "sessions.read": "Read own sessions",
    "sessions.run": "Run own sessions",
    "projects.read": "Read own projects",
    "projects.manage": "Manage own projects",
    "files.read": "Read own files",
    "files.write": "Write own files",
    "terminal.use": "Use own terminals and shell",
    "models.personal.manage": "Configure personal models",
    "models.use": "Use configured models",
    "users.read": "View accounts",
    "users.manage": "Manage accounts",
    "roles.manage": "Manage roles and assignments",
    "devices.inventory.read": "View platform device inventory",
    "devices.connection.manage": "Block and restore platform device connections",
    "settings.manage": "Manage platform settings",
    "models.manage": "Manage platform models",
    "audit.read": "Read management audit",
}
MEMBER_PERMISSIONS = (
    "devices.read",
    "devices.manage",
    "sessions.read",
    "sessions.run",
    "projects.read",
    "projects.manage",
    "files.read",
    "files.write",
    "terminal.use",
    "models.personal.manage",
    "models.use",
)
ADMIN_PERMISSIONS = tuple(PERMISSIONS)


def validate_permissions(values: list[str]) -> list[str]:
    unknown = set(values) - PERMISSIONS.keys()
    if unknown:
        raise ValueError("unknown permission: " + ", ".join(sorted(unknown)))
    return sorted(set(values))
