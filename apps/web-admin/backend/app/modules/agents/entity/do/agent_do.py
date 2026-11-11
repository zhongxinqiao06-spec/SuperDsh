"""智能体资产保存解析元数据，原文件统一由文件领域管理。"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class AgentAssetRow(Base):
    """同一账号同名同类型同摘要上传幂等，避免重复产生资料。"""

    __tablename__ = "agent_assets"
    __table_args__ = (UniqueConstraint("owner_id", "kind", "name", "sha256"),)
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    file_id: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(150))
    kind: Mapped[str] = mapped_column(String(40))
    size: Mapped[int] = mapped_column(Integer)
    media_type: Mapped[str] = mapped_column(String(150))
    sha256: Mapped[str] = mapped_column(String(64))
    extracted_text: Mapped[str] = mapped_column(Text)
    segments: Mapped[list[dict[str, object]]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
