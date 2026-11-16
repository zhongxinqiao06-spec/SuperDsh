"""创作准备的不可变确认与导演方案；当前工程仍由结构化表唯一承载。"""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class StageReview(Base):
    __tablename__ = "studio_stage_reviews"
    __table_args__ = (
        CheckConstraint("stage IN ('script','cast','storyboard','sample')"),
        CheckConstraint("decision IN ('confirmed','skipped')"),
        CheckConstraint("project_revision > 0"),
    )
    id: Mapped[str] = mapped_column(primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), index=True)
    stage: Mapped[str]
    project_revision: Mapped[int]
    input_hash: Mapped[str]
    decision: Mapped[str]
    reason: Mapped[str]
    selections: Mapped[dict] = mapped_column(JSONB)
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioProposal(Base):
    __tablename__ = "studio_proposals"
    __table_args__ = (
        UniqueConstraint("project_id", "request_key"),
        CheckConstraint("state IN ('pending','reviewed')"),
        CheckConstraint("base_revision > 0"),
    )
    id: Mapped[str] = mapped_column(primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), index=True)
    base_revision: Mapped[int]
    request_key: Mapped[str]
    request_hash: Mapped[str]
    base_document: Mapped[dict] = mapped_column(JSONB)
    proposed_document: Mapped[dict] = mapped_column(JSONB)
    state: Mapped[str] = mapped_column(default="pending")
    resolution: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
