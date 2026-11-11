"""导入保留外部会话标识，容量与旧平台TEXT列一致。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2608e7ac391"
down_revision: str | None = "a139f64c28bd"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """边界仍限制旧协议4096字符，存储不再将合法长身份变成数据库500错误。"""
    op.alter_column(
        "web_conversations",
        "external_session_id",
        type_=sa.Text(),
        existing_type=sa.String(255),
        existing_nullable=True,
    )


def downgrade() -> None:
    """存在长身份时让数据库拒绝缩列，不能截断后产生会话身份碰撞。"""
    op.alter_column(
        "web_conversations",
        "external_session_id",
        type_=sa.String(255),
        existing_type=sa.Text(),
        existing_nullable=True,
    )
