"""Stable login names, RBAC, revocable sessions and connection admission gates."""

import json
import os
import re

import sqlalchemy as sa
from alembic import op

revision = "v2_36"
down_revision = "v2_35"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from agent_server.core.permissions import ADMIN_PERMISSIONS, MEMBER_PERMISSIONS
    from agent_server.core.utc import utc_now
    from agent_server.infra.db.identity_schema import (
        auth_sessions,
        identity_audit,
        recovery_codes,
        roles,
        user_roles,
    )

    bind = op.get_bind()
    user_columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    connector_columns = {
        column["name"] for column in sa.inspect(bind).get_columns("connectors")
    }
    for name, column_type, default in [
        ("username", sa.Text(), None),
        ("auth_version", sa.Integer(), "0"),
        ("deleted_at", sa.Text(), None),
        ("deleted_by", sa.Text(), None),
        ("reset_required", sa.Integer(), "0"),
    ]:
        if name not in user_columns:
            op.add_column(
                "users",
                sa.Column(
                    name, column_type, nullable=default is None, server_default=default
                ),
            )
    for name in (
        "connection_blocked_at",
        "connection_blocked_by",
        "connection_blocked_reason",
        "connector_version",
    ):
        if name not in connector_columns:
            op.add_column("connectors", sa.Column(name, sa.Text(), nullable=True))
    for table in (roles, user_roles, auth_sessions, recovery_codes, identity_audit):
        table.create(bind, checkfirst=True)
    now = utc_now()
    for role_id, permissions in (
        ("admin", ADMIN_PERMISSIONS),
        ("member", MEMBER_PERMISSIONS),
    ):
        if not bind.execute(sa.select(roles.c.id).where(roles.c.id == role_id)).first():
            bind.execute(
                roles.insert().values(
                    id=role_id,
                    name=role_id,
                    builtin=1,
                    description="",
                    permissions_json=json.dumps(permissions),
                    updated_at=now,
                )
            )
    rows = (
        bind.execute(
            sa.text(
                "SELECT id, email, role, username FROM users ORDER BY created_at, id"
            )
        )
        .mappings()
        .all()
    )
    alias = os.environ.get("AGENT_SERVER_LOGIN_ALIAS", "").strip().lower()
    email = os.environ.get("AGENT_SERVER_LOGIN_EMAIL", "").strip().lower()
    target = next((row for row in rows if email and row["email"] == email), None)
    if alias and email and target is None:
        raise RuntimeError(
            "configured login alias target does not exist; resolve it before migrating"
        )
    if alias and not re.fullmatch(r"[a-z0-9_-]{3,32}", alias):
        raise RuntimeError("configured login alias cannot be migrated to a username")
    used: set[str] = {row["username"] for row in rows if row["username"]}
    if target:
        if alias in used and target["username"] != alias:
            raise RuntimeError(
                "configured login alias conflicts with an existing username"
            )
        used.add(alias)
    for row in rows:
        if target and row["id"] == target["id"]:
            username = alias
        elif row["username"]:
            username = row["username"]
        else:
            base = re.sub(r"[^a-z0-9_-]", "-", str(row["id"]).lower())[:32]
            base = base if len(base) >= 3 else "user-" + base
            username = base
            suffix = 1
            while username in used:
                suffix += 1
                username = f"{base[:26]}-{suffix}"
        used.add(username)
        bind.execute(
            sa.text("UPDATE users SET username=:name WHERE id=:id"),
            {"name": username, "id": row["id"]},
        )
        if not bind.execute(
            sa.select(user_roles.c.user_id).where(user_roles.c.user_id == row["id"])
        ).first():
            bind.execute(
                user_roles.insert().values(user_id=row["id"], role_id=row["role"])
            )
    if "idx_users_username" not in {
        index["name"] for index in sa.inspect(bind).get_indexes("users")
    }:
        op.create_index("idx_users_username", "users", ["username"], unique=True)


def downgrade() -> None:
    # Do not silently discard session revocations and login identities.
    raise RuntimeError(
        "identity migration requires restoring a pre-upgrade backup to downgrade"
    )
