"""Durable identity, role grants and revocable login sessions."""

from sqlalchemy import Column, ForeignKey, Integer, PrimaryKeyConstraint, Table, Text

from agent_server.infra.db.schema import metadata

roles = Table(
    "roles",
    metadata,
    Column("id", Text, primary_key=True),
    Column("name", Text, nullable=False),
    Column("description", Text, nullable=False, server_default=""),
    Column("builtin", Integer, nullable=False, server_default="0"),
    Column("permissions_json", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)
user_roles = Table(
    "user_roles",
    metadata,
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column(
        "role_id", Text, ForeignKey("roles.id", ondelete="RESTRICT"), nullable=False
    ),
    PrimaryKeyConstraint("user_id", "role_id"),
)
auth_sessions = Table(
    "auth_sessions",
    metadata,
    Column("id", Text, primary_key=True),
    Column(
        "user_id",
        Text,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("refresh_hash", Text, nullable=False, unique=True),
    Column("previous_refresh_hash", Text),
    Column("auth_version", Integer, nullable=False),
    Column("client_name", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("last_seen_at", Text, nullable=False),
    Column("expires_at", Text, nullable=False),
    Column("revoked_at", Text),
)
recovery_codes = Table(
    "recovery_codes",
    metadata,
    Column("code_hash", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("created_at", Text, nullable=False),
    Column("consumed_at", Text),
)
identity_audit = Table(
    "identity_audit",
    metadata,
    Column("id", Text, primary_key=True),
    Column("actor_id", Text, nullable=False),
    Column("action", Text, nullable=False),
    Column("target_id", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("detail_json", Text, nullable=False, server_default="{}"),
)
