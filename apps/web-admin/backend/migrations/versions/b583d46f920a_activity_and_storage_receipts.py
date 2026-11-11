"""活动时间与文件迁移收据，保留已发布的前序迁移。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b583d46f920a"
down_revision: str | None = "aed7903d126b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """新增可空活动时间，存储搬移通过持久收据恢复而不重复发布对象。"""
    op.add_column(
        "auth_sessions", sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_table(
        "web_file_migrations",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("file_id", sa.String(100), nullable=False),
        sa.Column("owner_id", sa.String(100), nullable=False),
        sa.Column("source_id", sa.String(100), nullable=False),
        sa.Column("source_key", sa.String(255), nullable=False),
        sa.Column("target_id", sa.String(100), nullable=False),
        sa.Column("target_key", sa.String(255), nullable=False),
        sa.Column("state", sa.String(30), nullable=False),
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_web_file_migrations_file_id", "web_file_migrations", ["file_id"])
    op.create_index("ix_web_file_migrations_owner_id", "web_file_migrations", ["owner_id"])


def downgrade() -> None:
    """回退只由显式运维命令触发。"""
    op.drop_table("web_file_migrations")
    op.drop_column("auth_sessions", "last_seen_at")
