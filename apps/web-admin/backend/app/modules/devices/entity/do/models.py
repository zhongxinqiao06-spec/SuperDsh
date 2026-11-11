"""设备身份、运行实例与配对凭据的持久化模型。"""

from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class DeviceRow(Base):
    __tablename__ = "web_devices"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    name: Mapped[str] = mapped_column(String(255))
    connector_kind: Mapped[str] = mapped_column(String(50), default="desktop")
    executor_kind: Mapped[str] = mapped_column(String(50), default="desktop")
    device_os: Mapped[str | None] = mapped_column(String(50), nullable=True)
    token_hash: Mapped[str] = mapped_column(String(64))
    token_prefix: Mapped[str] = mapped_column(String(20))
    revoked: Mapped[bool] = mapped_column(default=False)
    blocked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    blocked_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    preferences: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    metadata_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DeviceRuntimeRow(Base):
    __tablename__ = "web_device_runtimes"
    connector_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    runtime_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    runtime_type: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(128))
    configuration: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    active: Mapped[bool] = mapped_column(default=False)
    status: Mapped[str] = mapped_column(String(30), default="stopped")
    revision: Mapped[int] = mapped_column(Integer, default=1)
    metadata_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PairingRow(Base):
    __tablename__ = "web_device_pairings"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    code_hash: Mapped[str] = mapped_column(String(64), index=True)
    state: Mapped[str] = mapped_column(String(30))
    connector_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    encrypted_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    server_url: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
