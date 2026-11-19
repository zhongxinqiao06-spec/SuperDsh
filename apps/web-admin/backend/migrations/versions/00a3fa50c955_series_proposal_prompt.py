"""补齐已部署早期短剧建议表的冻结指令，不改写原稿和既有建议。"""

from alembic import op

revision = "00a3fa50c955"
down_revision = "00a2e93fb844"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 早期已记账数据库缺此列，后续新建库已有；两种已知结构均保留现存值。
    op.execute(
        "ALTER TABLE studio_series_proposals ADD COLUMN IF NOT EXISTS "
        "prompt_text TEXT NOT NULL DEFAULT ''"
    )


def downgrade() -> None:
    # 下级发布的新建库同样使用此列；降级保留冻结指令，避免删除用户建议。
    pass
