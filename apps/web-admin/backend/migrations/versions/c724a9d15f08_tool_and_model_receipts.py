"""通用工具持久收据与收费模型提交租约。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c724a9d15f08"
down_revision: str | None = "b583d46f920a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """扩展已存在模型记录时保留可空摘要；未知旧操作不能自动重放。"""
    op.add_column("model_operations", sa.Column("request_hash", sa.String(64), nullable=True))
    op.add_column("model_operations", sa.Column("receipt_ciphertext", sa.Text(), nullable=True))
    op.add_column("model_operations", sa.Column("lease_token", sa.String(64), nullable=True))
    op.add_column(
        "model_operations", sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_table(
        "web_tool_executions",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("owner_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("session_id", sa.String(100), nullable=False),
        sa.Column("binding_id", sa.String(), sa.ForeignKey("resource_bindings.id"), nullable=False),
        sa.Column("tool_id", sa.String(100), nullable=False),
        sa.Column("call_id", sa.String(200), nullable=False),
        sa.Column("phase", sa.String(30), nullable=False),
        sa.Column("input_hash", sa.String(64), nullable=False),
        sa.Column("state", sa.String(30), nullable=False),
        sa.Column("arguments", postgresql.JSONB(), nullable=False),
        sa.Column("result", postgresql.JSONB(), nullable=True),
        sa.Column("plan_hash", sa.String(64), nullable=True),
        sa.Column("skill_run_id", sa.String(), sa.ForeignKey("skill_runs.id"), nullable=True),
        sa.Column("skill_version", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_web_tool_executions_owner_id", "web_tool_executions", ["owner_id"])
    op.create_index("ix_web_tool_executions_session_id", "web_tool_executions", ["session_id"])


def downgrade() -> None:
    """仅显式迁移回退允许删除收据结构。"""
    op.drop_table("web_tool_executions")
    for column in ("lease_until", "lease_token", "receipt_ciphertext", "request_hash"):
        op.drop_column("model_operations", column)
