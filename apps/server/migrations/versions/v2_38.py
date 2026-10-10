"""Personal model ownership and leased, isolated server Harness bindings."""

import sqlalchemy as sa
from agent_server.infra.db.server_agent import server_agents
from alembic import op

revision = "v2_38"
down_revision = "v2_37"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "owner_user_id" not in {
        column["name"] for column in inspector.get_columns("platform_model_providers")
    }:
        op.add_column(
            "platform_model_providers",
            sa.Column("owner_user_id", sa.Text(), nullable=True),
        )
    op.create_index(
        "idx_model_providers_owner", "platform_model_providers", ["owner_user_id"]
    )
    if "executor_kind" not in {
        column["name"] for column in inspector.get_columns("connectors")
    }:
        op.add_column(
            "connectors",
            sa.Column(
                "executor_kind", sa.Text(), nullable=False, server_default="desktop"
            ),
        )
    server_agents.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    server_agents.drop(bind=op.get_bind(), checkfirst=True)
    op.drop_column("connectors", "executor_kind")
    op.drop_index("idx_model_providers_owner", "platform_model_providers")
    op.drop_column("platform_model_providers", "owner_user_id")
