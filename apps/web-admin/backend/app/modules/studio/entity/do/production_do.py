"""制作计划冻结选择范围，任务处置回执记录取消、核对与采用的操作者。"""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class GenerationPlan(Base):
    __tablename__ = "studio_generation_plans"
    __table_args__ = (
        UniqueConstraint("owner", "request_key"),
        CheckConstraint("num_nonnulls(project, entity) = 1"),
    )
    id: Mapped[str] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    project: Mapped[str | None] = mapped_column(ForeignKey("studio_projects.id"))
    entity: Mapped[str | None] = mapped_column(ForeignKey("studio_entities.id"))
    revision: Mapped[int]
    request_key: Mapped[str]
    request_hash: Mapped[str]
    plan_hash: Mapped[str]
    intent: Mapped[dict] = mapped_column(JSONB)
    manifest: Mapped[dict] = mapped_column(JSONB)
    state: Mapped[str] = mapped_column(default="draft")
    result: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JobAction(Base):
    __tablename__ = "studio_job_actions"
    __table_args__ = (UniqueConstraint("owner", "request_key"),)
    id: Mapped[str] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"))
    job: Mapped[str] = mapped_column(ForeignKey("studio_media_jobs.id"), index=True)
    request_key: Mapped[str]
    request_hash: Mapped[str]
    kind: Mapped[str]
    detail: Mapped[dict] = mapped_column(JSONB)
    result: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
