"""Owned platform model providers, encrypted credentials and default selection."""

from alembic import op

from agent_server.infra.db.platform_models import metadata

revision = "v2_37"
down_revision = "v2_36"
branch_labels = None
depends_on = None


def upgrade() -> None:
    metadata.create_all(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    metadata.drop_all(bind=op.get_bind(), checkfirst=True)
