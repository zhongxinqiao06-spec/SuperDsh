"""作品与个人库的来源绑定和幂等操作收据；媒体与设定沿用各自的版本表。"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class LibraryBinding(Base):
    """家族标识可能指向设定或媒体，由服务按归属与类型校验，不以名称推断来源。"""

    __tablename__ = "studio_library_bindings"
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    project_family_id: Mapped[str] = mapped_column(primary_key=True)
    project_variant_id: Mapped[str] = mapped_column(primary_key=True, default="")
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    library_family_id: Mapped[str] = mapped_column(index=True)
    imported_version_id: Mapped[str | None]
    published_version_id: Mapped[str | None]
    project_version_id: Mapped[str]
    field_versions: Mapped[dict] = mapped_column(JSONB, default=dict)
    revision: Mapped[int] = mapped_column(default=1)


class LibraryOperation(Base):
    """同一请求号与领域写入原子提交，断网重试不会重复创建角色、造型或工程修订。"""

    __tablename__ = "studio_library_operations"
    id: Mapped[str] = mapped_column(primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    request_key: Mapped[str] = mapped_column(String(100))
    request_hash: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("owner_id", "request_key"),)
