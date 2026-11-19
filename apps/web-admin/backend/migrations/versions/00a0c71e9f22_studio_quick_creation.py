"""新增快速创作草稿；历史作品继续使用原分镜工程及所有权。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "00a0c71e9f22"
down_revision = "00895f4a6c12"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "studio_projects",
        sa.Column("creation_mode", sa.String(), nullable=False, server_default="storyboard"),
    )
    op.add_column(
        "studio_projects",
        sa.Column("quick_draft", postgresql.JSONB(), nullable=False, server_default="{}"),
    )
    op.create_check_constraint(
        "ck_studio_creation_mode", "studio_projects", "creation_mode IN ('storyboard', 'quick')"
    )


def downgrade() -> None:
    # 有快速草稿时禁止静默丢失用户输入，先在原版本完成显式升级或导出。
    if op.get_bind().scalar(
        sa.text("SELECT count(*) FROM studio_projects WHERE creation_mode='quick'")
    ):
        raise RuntimeError("仍有快速作品，不能降级并删除其草稿")
    op.drop_constraint("ck_studio_creation_mode", "studio_projects", type_="check")
    op.drop_column("studio_projects", "quick_draft")
    op.drop_column("studio_projects", "creation_mode")
