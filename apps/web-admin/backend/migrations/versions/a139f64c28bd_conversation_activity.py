"""区分会话消息活动、消息时间、排序和管理元数据更新时间。"""

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "a139f64c28bd"
down_revision: str | None = "f018e53b27ac"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """仅扩展新端投影表，历史时间从已提交事件回填，不把本次升级当作消息活动。"""
    for name in ("pinned_at", "archived_at", "last_activity_at", "last_item_at", "sort_at"):
        op.add_column(
            "web_conversations", sa.Column(name, sa.DateTime(timezone=True), nullable=True)
        )
    op.add_column(
        "web_conversations", sa.Column("last_item_order_seq", sa.BigInteger(), nullable=True)
    )
    op.add_column("web_projects", sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "web_conversation_items", sa.Column("item_time", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute(
        "UPDATE web_conversations SET pinned_at = CASE WHEN pinned THEN updated_at END, archived_at = CASE WHEN archived THEN updated_at END, sort_at = created_at"
    )
    op.execute("UPDATE web_projects SET pinned_at = updated_at WHERE pinned")
    op.execute("""UPDATE web_conversation_items AS i SET item_time = COALESCE(
        (SELECT emitted_at FROM web_conversation_events e WHERE e.session_id = i.session_id AND e.sequence = i.sequence),
        (SELECT created_at FROM web_conversations s WHERE s.id = i.session_id))""")
    connection = op.get_bind()
    # ISO时间逐条有界解析，避免一个历史非法字符串令整库升级失败。
    rows = connection.execute(
        sa.text("SELECT session_id, item_id, payload FROM web_conversation_items")
    ).mappings()
    for row in rows:
        payload = row["payload"]
        created = payload.get("createdAt") if isinstance(payload, dict) else None
        if not isinstance(created, str):
            continue
        try:
            timestamp = datetime.fromisoformat(created.replace("Z", "+00:00"))
        except ValueError:
            continue
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=UTC)
        connection.execute(
            sa.text(
                "UPDATE web_conversation_items SET item_time = :time WHERE session_id = :session AND item_id = :item"
            ),
            {"time": timestamp, "session": row["session_id"], "item": row["item_id"]},
        )
    op.alter_column("web_conversation_items", "item_time", nullable=False)
    op.create_index(
        "ix_web_conversation_items_activity",
        "web_conversation_items",
        ["session_id", "item_time", "order_seq"],
    )
    op.execute("""UPDATE web_conversations AS s SET last_activity_at = activity.stamp, sort_at = activity.stamp
        FROM (SELECT session_id, MAX(emitted_at) AS stamp FROM web_conversation_events
        WHERE type IN ('timeline.item_created', 'timeline.item_updated') GROUP BY session_id) activity
        WHERE activity.session_id = s.id""")
    op.execute("""UPDATE web_conversations AS s SET last_item_at = latest.item_time, last_item_order_seq = latest.order_seq
        FROM (SELECT DISTINCT ON (session_id) session_id, item_time, order_seq FROM web_conversation_items
        ORDER BY session_id, item_time DESC, order_seq DESC) latest WHERE latest.session_id = s.id""")


def downgrade() -> None:
    """显式回退只删除本次新增的投影列，不修改时间线正文或所有者。"""
    op.drop_index("ix_web_conversation_items_activity", table_name="web_conversation_items")
    op.drop_column("web_conversation_items", "item_time")
    op.drop_column("web_projects", "pinned_at")
    for name in (
        "pinned_at",
        "archived_at",
        "last_activity_at",
        "last_item_at",
        "sort_at",
        "last_item_order_seq",
    ):
        op.drop_column("web_conversations", name)
