"""保留旧内联附件允许的显示名称长度，名称不参与本地路径。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c841f50b3ae2"
down_revision: str | None = "b2608e7ac391"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """旧stage接收512字符名称；统一文件主记录必须能够完整持久化。"""
    op.alter_column(
        "web_file_entries",
        "name",
        type_=sa.String(512),
        existing_type=sa.String(255),
        existing_nullable=False,
    )


def downgrade() -> None:
    """不自动截断显示名称，存在超长名称时拒绝缩列。"""
    op.alter_column(
        "web_file_entries",
        "name",
        type_=sa.String(255),
        existing_type=sa.String(512),
        existing_nullable=False,
    )
