"""Versioned product navigation, updated atomically with management audit."""

from sqlalchemy import Column, Integer, Table, Text

from agent_server.infra.db.schema import metadata

navigation_settings = Table(
    "navigation_settings",
    metadata,
    Column("id", Text, primary_key=True),
    Column("version", Integer, nullable=False),
    Column("items_json", Text, nullable=False),
    Column("updated_by", Text),
    Column("updated_at", Text, nullable=False),
)
