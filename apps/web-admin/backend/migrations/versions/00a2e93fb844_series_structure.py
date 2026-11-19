"""新增分集结构预览和软归档，保留既有工程与媒体来源。"""

import sqlalchemy as sa
from alembic import op

revision = "00a2e93fb844"
down_revision = "00a1d82fa733"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "studio_series_episodes",
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("studio_series_episodes", sa.Column("archived_at", sa.DateTime(timezone=True)))
    op.add_column("studio_series_episodes", sa.Column("archive_reason", sa.Text()))
    op.execute("""
        CREATE TABLE studio_series_structure_plans (
            id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES studio_series(id),
            revision INTEGER NOT NULL, manifest JSONB NOT NULL, plan_hash TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'prepared', result JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (state IN ('prepared','confirmed'))
        )
    """)
    op.create_index(
        "ix_studio_series_structure_plans_series_id", "studio_series_structure_plans", ["series_id"]
    )


def downgrade() -> None:
    op.drop_table("studio_series_structure_plans")
    op.drop_column("studio_series_episodes", "archive_reason")
    op.drop_column("studio_series_episodes", "archived_at")
    op.drop_column("studio_series_episodes", "archived")
