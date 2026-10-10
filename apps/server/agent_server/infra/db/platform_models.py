"""Owned platform model storage; provider secrets never enter client catalogs."""

from sqlalchemy import Column, Integer, MetaData, Table, Text

metadata = MetaData()

providers = Table(
    "platform_model_providers",
    metadata,
    Column("id", Text, primary_key=True),
    Column("owner_user_id", Text),
    Column("name", Text, nullable=False),
    Column("protocol", Text, nullable=False),
    Column("base_url", Text, nullable=False),
    Column("key_ciphertext", Text),
    Column("models_json", Text, nullable=False),
    Column("enabled", Integer, nullable=False, server_default="1"),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)

defaults = Table(
    "platform_model_defaults",
    metadata,
    Column("id", Text, primary_key=True),
    Column("provider_id", Text, nullable=False),
    Column("model_id", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)
