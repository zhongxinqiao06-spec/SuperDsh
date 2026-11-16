"""AI 局部编辑记录仅保存意图与建议，执行仍由作品的 DSH 会话承担。"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class StudioTextEdit(Base):
    __tablename__ = "studio_text_edits"
    __table_args__ = (UniqueConstraint("project_id", "request_key"),)
    id: Mapped[str] = mapped_column(primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), index=True)
    request_key: Mapped[str]
    request_hash: Mapped[str]
    base_revision: Mapped[int]
    target: Mapped[dict] = mapped_column(JSONB)
    base_text: Mapped[str]
    instruction: Mapped[str]
    suggestion: Mapped[str | None]
    state: Mapped[str] = mapped_column(default="waiting")
    applied: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
