"""补齐账号更新时间契约，历史记录按创建时间回填。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f018e53b27ac"
down_revision: str | None = "e907d42a16fb"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """只扩展新管理端账号表，不改变密码、授权代际或所有者。"""
    op.add_column("users", sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE users SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP)")


def downgrade() -> None:
    """仅显式迁移回退会删除新增列。"""
    op.drop_column("users", "updated_at")
