"""工作台项目、会话、消息投影及恢复游标持久化。"""

from datetime import UTC, datetime

from sqlalchemy import JSON, BigInteger, DateTime, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class ProjectRow(Base):
    __tablename__ = "web_projects"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    connector_id: Mapped[str] = mapped_column(String(100), index=True)
    name: Mapped[str] = mapped_column(String(255))
    workspace_path: Mapped[str] = mapped_column(Text)
    pinned: Mapped[bool] = mapped_column(default=False)
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    manually_created: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SessionRow(Base):
    __tablename__ = "web_conversations"
    __table_args__ = (UniqueConstraint("owner_id", "creation_key"),)
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    connector_id: Mapped[str] = mapped_column(String(100), index=True)
    project_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    runtime_id: Mapped[str] = mapped_column(String(100))
    runtime_type: Mapped[str] = mapped_column(String(100))
    external_session_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    creation_key: Mapped[str | None] = mapped_column(String(160), nullable=True)
    title: Mapped[str] = mapped_column(String(500))
    cwd: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(30), default="idle")
    archived: Mapped[bool] = mapped_column(default=False)
    pinned: Mapped[bool] = mapped_column(default=False)
    takeover: Mapped[bool] = mapped_column(default=False)
    # 元数据更新、消息发生时间与平台观察到消息的时间分别保存，不能互相代替。
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_activity_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_item_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_item_order_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    sort_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sequence: Mapped[int] = mapped_column(BigInteger, default=0)
    last_read_seq: Mapped[int] = mapped_column(BigInteger, default=0)
    latest_turn_end_seq: Mapped[int] = mapped_column(BigInteger, default=0)
    state: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    agent_binding: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    source: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class TimelineRow(Base):
    __tablename__ = "web_conversation_items"
    __table_args__ = (
        Index("ix_web_conversation_items_activity", "session_id", "item_time", "order_seq"),
    )
    session_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    sequence: Mapped[int] = mapped_column(BigInteger)
    order_seq: Mapped[int] = mapped_column(BigInteger)
    item_time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    payload: Mapped[dict[str, object]] = mapped_column(JSON)


class ConversationEventRow(Base):
    __tablename__ = "web_conversation_events"
    session_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    sequence: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    type: Mapped[str] = mapped_column(String(100))
    payload: Mapped[dict[str, object]] = mapped_column(JSON)
    emitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ConversationReceiptRow(Base):
    __tablename__ = "web_conversation_receipts"
    session_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    operation_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    digest: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(30))
    result: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)


class ProjectionCursorRow(Base):
    __tablename__ = "web_conversation_cursors"
    owner_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    cursor: Mapped[int] = mapped_column(BigInteger, default=0)
    snapshot: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)


class ConversationShareRow(Base):
    __tablename__ = "web_conversation_shares"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    session_id: Mapped[str] = mapped_column(String(100), index=True)
    snapshot: Mapped[dict[str, object]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WebSocketTicketRow(Base):
    __tablename__ = "web_socket_tickets"
    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    access_token: Mapped[str] = mapped_column(Text)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    client_id: Mapped[str] = mapped_column(String(160))
    scope: Mapped[dict[str, object]] = mapped_column(JSON)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
