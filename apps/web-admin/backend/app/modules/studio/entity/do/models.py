"""创作域持久对象。工程快照和素材版本写入后不可变。"""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class StudioProject(Base):
    __tablename__ = "studio_projects"
    id: Mapped[str] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str]
    revision: Mapped[int]
    proposal: Mapped[dict | None] = mapped_column(JSONB)
    session_id: Mapped[str | None] = mapped_column(unique=True)
    brief: Mapped[str] = mapped_column(default="", server_default="")
    lifecycle: Mapped[str] = mapped_column(default="active", server_default="active")
    aspect_width: Mapped[int | None]
    aspect_height: Mapped[int | None]
    target_duration_ms: Mapped[int | None]
    language: Mapped[str | None]
    style_brief: Mapped[str] = mapped_column(default="", server_default="")
    creation_key: Mapped[str | None]
    creation_hash: Mapped[str | None]
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("id", "owner"),
        UniqueConstraint("owner", "creation_key"),
        CheckConstraint("lifecycle IN ('active', 'archived')"),
        CheckConstraint(
            "(aspect_width IS NULL AND aspect_height IS NULL) OR "
            "(aspect_width IS NOT NULL AND aspect_height IS NOT NULL "
            "AND aspect_width > 0 AND aspect_height > 0)"
        ),
        CheckConstraint("target_duration_ms IS NULL OR target_duration_ms > 0"),
    )
    updated: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StudioRevision(Base):
    __tablename__ = "studio_revisions"
    project: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    revision: Mapped[int] = mapped_column(primary_key=True)
    document: Mapped[dict] = mapped_column(JSONB)
    label: Mapped[str]


class StudioAsset(Base):
    """只读兼容视图映射；写入必须经设定/媒体版本 DAO，禁止 INSERT 此视图。"""

    __tablename__ = "studio_assets"
    id: Mapped[str] = mapped_column(primary_key=True)
    family: Mapped[str] = mapped_column(index=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    project: Mapped[str | None] = mapped_column(ForeignKey("studio_projects.id"))
    parent: Mapped[str | None] = mapped_column(ForeignKey("studio_assets.id"))
    definition: Mapped[dict] = mapped_column(JSONB)


class MediaJob(Base):
    """以同一次提交的项目、请求号、镜头或台词去重。"""

    __tablename__ = "studio_media_jobs"
    __table_args__ = (
        UniqueConstraint("project", "request_key", "subject"),
        Index(
            "uq_studio_personal_request",
            "owner",
            "request_key",
            "subject",
            unique=True,
            postgresql_where=text("project IS NULL"),
        ),
        CheckConstraint(
            "project IS NOT NULL OR (owner IS NOT NULL AND library_entity IS NOT NULL)",
            name="ck_studio_job_scope",
        ),
        UniqueConstraint("project", "id"),
    )
    id: Mapped[str] = mapped_column(primary_key=True)
    project: Mapped[str | None] = mapped_column(ForeignKey("studio_projects.id"), index=True)
    owner: Mapped[str | None] = mapped_column(ForeignKey("users.id"), index=True)
    library_entity: Mapped[str | None] = mapped_column(ForeignKey("studio_entities.id"))
    cancel_requested: Mapped[bool] = mapped_column(default=False, server_default="false")
    request_key: Mapped[str]
    subject: Mapped[str]
    kind: Mapped[str]
    revision: Mapped[int]
    state: Mapped[str] = mapped_column(index=True)
    payload: Mapped[dict] = mapped_column(JSONB)
    provider_id: Mapped[str | None]
    error: Mapped[str | None]
    updated: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
