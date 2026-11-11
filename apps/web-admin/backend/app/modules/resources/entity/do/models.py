"""通用资源、不可变版本、绑定及初始化标记的数据实体。"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class ResourceRow(Base):
    """当前可编辑资源，不按助手名称创建专属表。"""

    __tablename__ = "resources"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    kind: Mapped[str] = mapped_column(String(30), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean)
    published: Mapped[bool] = mapped_column(Boolean)
    version: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict[str, object]] = mapped_column(JSONB)
    secret_ciphertext: Mapped[str | None] = mapped_column(Text)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ResourceVersionRow(Base):
    """已保存历史版本只追加，绑定引用的版本永久可读取。"""

    __tablename__ = "resource_versions"
    resource_id: Mapped[str] = mapped_column(ForeignKey("resources.id"), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot: Mapped[dict[str, object]] = mapped_column(JSONB)
    secret_ciphertext: Mapped[str | None] = mapped_column(Text)


class BindingRow(Base):
    """会话绑定快照与授权主体，不复制凭据明文。"""

    __tablename__ = "resource_bindings"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    session_id: Mapped[str] = mapped_column(String(200), index=True)
    version: Mapped[int] = mapped_column(Integer)
    snapshots: Mapped[list[dict[str, object]]] = mapped_column(JSONB)


class InitializationRow(Base):
    """一次性默认资源导入标记；删除示例后不会被自动恢复。"""

    __tablename__ = "resource_initializations"
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    package_id: Mapped[str] = mapped_column(String(100), primary_key=True)
