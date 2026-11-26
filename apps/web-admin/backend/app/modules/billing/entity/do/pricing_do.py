"""不可变的定价修订及按账号保存的逐项报价快照。"""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class PricingVersion(Base):
    __tablename__ = "billing_pricing_versions"
    __table_args__ = (
        UniqueConstraint("domain", "scope", "revision"),
        UniqueConstraint("actor", "business_key"),
        CheckConstraint("domain IN ('plan','rate') AND revision > 0"),
        Index("ix_pricing_effective", "domain", "scope", "effective_at"),
    )
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    domain: Mapped[str] = mapped_column(String(8))
    scope: Mapped[str] = mapped_column(String(420))
    revision: Mapped[int]
    payload: Mapped[dict] = mapped_column(JSONB)
    actor: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    business_key: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    effective_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    publication: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))


class UsageQuote(Base):
    __tablename__ = "billing_usage_quotes"
    __table_args__ = (UniqueConstraint("owner", "request_key"),)
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"))
    request_key: Mapped[str] = mapped_column(String(90))
    source: Mapped[str] = mapped_column(String(160))
    snapshot: Mapped[dict] = mapped_column(JSONB)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
