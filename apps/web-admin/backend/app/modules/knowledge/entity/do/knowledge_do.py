"""知识索引任务和 Embedding 配置持久化；进程重启不把运行中任务误报成功。"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class KnowledgeProfileRow(Base):
    """全局语义配置仅在新代际全部准备成功后切换。"""

    __tablename__ = "knowledge_embedding_profiles"
    id: Mapped[str] = mapped_column(String(50), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    profile: Mapped[dict[str, object]] = mapped_column(JSONB)
    credential: Mapped[str | None] = mapped_column(Text)


class KnowledgeDocumentRow(Base):
    """每份资料的每个索引代际有独立状态，attempt 防止迟到结果覆盖重试。"""

    __tablename__ = "knowledge_documents"
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    asset_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    generation: Mapped[str] = mapped_column(String(64), primary_key=True)
    sha256: Mapped[str] = mapped_column(String(64))
    filename: Mapped[str] = mapped_column(String(150))
    state: Mapped[str] = mapped_column(String(20))
    attempt: Mapped[str] = mapped_column(String(100))
    chunks: Mapped[int] = mapped_column(Integer)
    message: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
