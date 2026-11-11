"""设备Shell执行收据和终端会话所有权。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d865b031c2e9"
down_revision: str | None = "c724a9d15f08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """新表保留进程中断事实，启动恢复不得重做命令。"""
    op.create_table(
        "web_shell_tasks",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("owner_id", sa.String(100), nullable=False),
        sa.Column("connector_id", sa.String(100), nullable=False),
        sa.Column("session_id", sa.String(150), nullable=False),
        sa.Column("command", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("root", sa.Text(), nullable=False),
        sa.Column("cwd", sa.Text(), nullable=False),
        sa.Column("timeout_ms", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(30), nullable=False),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("error", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "web_terminal_bindings",
        sa.Column("terminal_id", sa.String(100), primary_key=True),
        sa.Column("owner_id", sa.String(100), nullable=False),
        sa.Column("connector_id", sa.String(100), nullable=False),
        sa.Column("session_id", sa.String(150), nullable=False),
        sa.Column("root", sa.Text(), nullable=False),
        sa.Column("cwd", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    for table in ("web_shell_tasks", "web_terminal_bindings"):
        for field in ("owner_id", "connector_id"):
            op.create_index(f"ix_{table}_{field}", table, [field])


def downgrade() -> None:
    """回退由显式运维命令触发，不通过运行时清理删除业务收据。"""
    op.drop_table("web_terminal_bindings")
    op.drop_table("web_shell_tasks")
