"""Owned binding and lease for one server Harness per platform account."""

from sqlalchemy import Column, ForeignKey, Integer, Table, Text

from agent_server.infra.db.schema import metadata

server_agents = Table(
    "server_agents",
    metadata,
    Column(
        "owner_user_id",
        Text,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "connector_id",
        Text,
        ForeignKey("connectors.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    ),
    Column("runtime_id", Text, nullable=False),
    Column("project_id", Text, ForeignKey("projects.id", ondelete="SET NULL")),
    Column("credential_ciphertext", Text, nullable=False),
    Column("status", Text, nullable=False, server_default="stopped"),
    Column("error", Text),
    Column("lease_id", Text),
    Column("lease_expires_at", Integer, nullable=False, server_default="0"),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)
