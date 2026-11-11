"""${message}。"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision: str = ${repr(up_revision)}
down_revision: str | None = ${repr(down_revision)}
branch_labels: str | Sequence[str] | None = ${repr(branch_labels)}
depends_on: str | Sequence[str] | None = ${repr(depends_on)}


def upgrade() -> None:
    """创建本次迁移的固定结构，不读取运行时 ORM 元数据。"""
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    """仅用于明确授权的新平台数据库回退。"""
    ${downgrades if downgrades else "pass"}
