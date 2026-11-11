"""文件、分片上传和存储策略的持久模型，不承载业务授权。"""

from datetime import datetime

from sqlalchemy import JSON, BigInteger, DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class FileEntryRow(Base):
    """对象与用户可见版本分开引用，删除标记不破坏历史链。"""

    __tablename__ = "web_file_entries"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    storage_id: Mapped[str] = mapped_column(String(100))
    object_key: Mapped[str] = mapped_column(String(300))
    name: Mapped[str] = mapped_column(String(512))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    media_type: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(30))
    version: Mapped[int] = mapped_column(Integer, default=1)
    previous_file_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FileReferenceRow(Base):
    """资源引用只记录关联身份，内容仍通过所有者权限读取。"""

    __tablename__ = "web_file_references"
    file_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), primary_key=True)
    resource_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)


class FileUploadRow(Base):
    """幂等上传及已提交分片目录，重启可继续未过期上传。"""

    __tablename__ = "web_file_uploads"
    __table_args__ = (UniqueConstraint("owner_id", "idempotency_key"),)
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(160))
    name: Mapped[str] = mapped_column(String(255))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    media_type: Mapped[str] = mapped_column(String(200))
    storage_id: Mapped[str] = mapped_column(String(100))
    previous_file_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state: Mapped[str] = mapped_column(String(30), default="receiving")
    parts: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    file_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class StorageConnectionRow(Base):
    """存储连接凭据加密保存，响应只暴露已配置标记。"""

    __tablename__ = "web_storage_connections"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    configuration: Mapped[dict[str, object]] = mapped_column(JSON)
    credentials: Mapped[str | None] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(default=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)


class StorageSettingsRow(Base):
    """全局存储选择与限额，更新时检查修订号。"""

    __tablename__ = "web_storage_settings"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    active_connection_id: Mapped[str] = mapped_column(String(100))
    policy: Mapped[dict[str, object]] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(Integer, default=1)


class FileMigrationRow(Base):
    """对象迁移收据先保存目标，再校验内容后切换元数据指针。"""

    __tablename__ = "web_file_migrations"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    file_id: Mapped[str] = mapped_column(String(100), index=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    source_id: Mapped[str] = mapped_column(String(100))
    source_key: Mapped[str] = mapped_column(String(255))
    target_id: Mapped[str] = mapped_column(String(100))
    target_key: Mapped[str] = mapped_column(String(255))
    state: Mapped[str] = mapped_column(String(30))
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class FileCleanupRow(Base):
    """物理删除收据与元数据变更同事务写入，存储离线时保留可恢复的对象身份。"""

    __tablename__ = "web_file_cleanup"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    file_id: Mapped[str] = mapped_column(String(100))
    storage_id: Mapped[str] = mapped_column(String(100))
    object_key: Mapped[str] = mapped_column(String(300))
    purpose: Mapped[str] = mapped_column(String(30))
    state: Mapped[str] = mapped_column(String(30), index=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
