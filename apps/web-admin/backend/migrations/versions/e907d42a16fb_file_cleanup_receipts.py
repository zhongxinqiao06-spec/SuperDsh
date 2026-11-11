"""文件物理清理持久收据，元数据提交后存储故障仍可恢复。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e907d42a16fb"
down_revision: str | None = "d865b031c2e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """只创建本阶段的新收据表，不改既有对象或用户数据。"""
    op.create_table(
        "web_file_cleanup",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("owner_id", sa.String(100), nullable=False),
        sa.Column("file_id", sa.String(100), nullable=False),
        sa.Column("storage_id", sa.String(100), nullable=False),
        sa.Column("object_key", sa.String(300), nullable=False),
        sa.Column("purpose", sa.String(30), nullable=False),
        sa.Column("state", sa.String(30), nullable=False),
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_web_file_cleanup_owner_id", "web_file_cleanup", ["owner_id"])
    op.create_index("ix_web_file_cleanup_state", "web_file_cleanup", ["state"])


def downgrade() -> None:
    """回退需显式运维执行，不能作为日常缓存清理调用。"""
    op.drop_table("web_file_cleanup")
