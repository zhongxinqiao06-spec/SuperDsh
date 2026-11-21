"""保存供应商套餐登记与管理员接管状态，保留既有连接、密钥和模型修订。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "01bd73a6cae2"
down_revision = "00a3fa50c955"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "model_connections", sa.Column("subscription", JSONB, nullable=False, server_default="{}")
    )
    for table in ("model_connections", "model_configurations"):
        op.add_column(
            table,
            sa.Column("admin_managed", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    for table in ("model_connections", "model_configurations"):
        op.drop_column(table, "admin_managed")
    op.drop_column("model_connections", "subscription")
