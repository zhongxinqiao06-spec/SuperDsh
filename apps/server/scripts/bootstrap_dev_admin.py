"""Create the local development admin after the launcher has migrated its database.

The development launcher owns database selection and must enable this command only
for its managed local database. Normal API startup never imports this script.
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Literal

from sqlalchemy import select

from agent_server.core.auth import password_salt
from agent_server.core.permissions import ADMIN_PERMISSIONS
from agent_server.infra.db.identity_schema import user_roles
from agent_server.infra.db.migrations import (
    DatabaseMigrationError,
    require_current_database,
)
from agent_server.infra.db.schema import users
from agent_server.infra.repositories.facade import Store

DEV_ADMIN_USERNAME = "admin"
DEV_ADMIN_PASSWORD = "admin123"
BootstrapResult = Literal["created", "keptexisting"]


class DevAdminBootstrapError(RuntimeError):
    """A safe diagnostic that contains no database credentials or password hashes."""


async def _existing_admin(store: Store) -> bool:
    # Include disabled and deleted identities: they must never be replaced or
    # restored just because the development server has been restarted.
    async with store.engine.connect() as connection:
        row = (
            (
                await connection.execute(
                    select(users.c.id, users.c.password_hash).where(
                        users.c.username == DEV_ADMIN_USERNAME
                    )
                )
            )
            .mappings()
            .first()
        )
        admin_grant = (
            (
                await connection.execute(
                    select(user_roles.c.role_id).where(
                        user_roles.c.user_id == row["id"],
                        user_roles.c.role_id == "admin",
                    )
                )
            ).first()
            if row is not None
            else None
        )
    if row is None:
        return False
    user = await store.get_user(row["id"])
    if (
        user.disabled
        or user.deletedAt
        or user.resetRequired
        or admin_grant is None
        or "admin" not in user.roles
        or not set(ADMIN_PERMISSIONS).issubset(user.permissions)
        or not password_salt(row["password_hash"])
    ):
        raise DevAdminBootstrapError(
            "username 'admin' already exists but is not an available administrator; "
            "the account was left unchanged. Resolve its status explicitly."
        )
    return True


async def ensure_dev_admin(store: Store) -> BootstrapResult:
    """Keep the existing identity, or create one through the normal Store path."""
    try:
        await require_current_database(store.engine)
    except DatabaseMigrationError as exc:
        raise DevAdminBootstrapError(
            "the development database requires migration; run the development "
            "launcher migration before initializing its admin"
        ) from exc

    if await _existing_admin(store):
        return "keptexisting"
    try:
        user = await store.create_email_user(
            email=None,
            username=DEV_ADMIN_USERNAME,
            display_name=DEV_ADMIN_USERNAME,
            password=DEV_ADMIN_PASSWORD,
            role="admin",
        )
    except ValueError:
        # The Store transaction and unique username index arbitrate concurrent
        # launchers. Re-read only after that transaction has rolled back.
        if await _existing_admin(store):
            return "keptexisting"
        raise
    if user is None:
        raise DevAdminBootstrapError("the development admin was not created")
    await store.record_audit("system:dev-bootstrap", "user.created", user.userId)
    return "created"


async def _run(db_url: str) -> BootstrapResult:
    store = Store(db_url=db_url)
    try:
        return await ensure_dev_admin(store)
    finally:
        await store.close()


def main() -> int:
    if os.environ.get("SUPERDSH_BOOTSTRAP_DEV_ADMIN") != "1":
        print(
            "Development admin bootstrap requires SUPERDSH_BOOTSTRAP_DEV_ADMIN=1 "
            "from the managed local development launcher.",
            file=sys.stderr,
        )
        return 1
    db_url = os.environ.get("AGENT_SERVER_DB_URL", "").strip()
    if not db_url:
        print(
            "Development admin bootstrap requires AGENT_SERVER_DB_URL.", file=sys.stderr
        )
        return 1
    try:
        result = asyncio.run(_run(db_url))
    except DevAdminBootstrapError as exc:
        print(f"Development admin bootstrap failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - CLI boundary must not leak driver secrets
        # Driver and SQLAlchemy exception messages can include connection URLs,
        # SQL parameters or hashes. Never forward those through launcher logs.
        print(
            f"Development admin bootstrap failed ({type(exc).__name__}); "
            "check the managed development database and its migrations.",
            file=sys.stderr,
        )
        return 1
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
