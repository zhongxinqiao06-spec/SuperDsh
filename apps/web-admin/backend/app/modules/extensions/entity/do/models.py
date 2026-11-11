"""扩展来源与不可变安装版本，凭据和本地安装路径不进入公开DTO。"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class ExtensionSourceRow(Base):
    """平台级来源需要独立安装权限，revision防止并发覆盖授权。"""

    __tablename__ = "extension_sources"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(30))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    active_version: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(30), default="ready")
    diagnostic: Mapped[str | None] = mapped_column(Text)
    endpoint: Mapped[str | None] = mapped_column(Text)
    secret_ciphertext: Mapped[str | None] = mapped_column(Text)
    installed_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ExtensionVersionRow(Base):
    """同来源同版本的内容哈希不可变，回滚只改变来源的活动版本。"""

    __tablename__ = "extension_versions"
    source_id: Mapped[str] = mapped_column(ForeignKey("extension_sources.id"), primary_key=True)
    version: Mapped[str] = mapped_column(String(100), primary_key=True)
    digest: Mapped[str] = mapped_column(String(64))
    manifest: Mapped[dict[str, object]] = mapped_column(JSONB)
    installation_path: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
