"""办理单冻结预览与实收依据，会员周期绑定唯一的发放批次。"""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class BillingOperationRow(Base):
    __tablename__ = "billing_operations"
    __table_args__ = (
        UniqueConstraint("actor_id", "business_key"),
        UniqueConstraint("user_id", "id"),
        UniqueConstraint("receipt"),
        Index("ix_billing_op_owner_time", "user_id", "confirmed_at"),
    )
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    business_key: Mapped[str] = mapped_column(String(80))
    request: Mapped[dict[str, object]] = mapped_column(JSONB)
    quote: Mapped[dict[str, object]] = mapped_column(JSONB)
    receipt: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BillingPeriodRow(Base):
    __tablename__ = "billing_periods"
    __table_args__ = (
        UniqueConstraint("user_id", "starts_at"),
        ForeignKeyConstraint(
            ["user_id", "operation_id"], ["billing_operations.user_id", "billing_operations.id"]
        ),
        ForeignKeyConstraint(
            ["user_id", "lot_id"], ["billing_credit_lots.user_id", "billing_credit_lots.id"]
        ),
        CheckConstraint("ends_at > starts_at"),
    )
    operation_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    plan_version_id: Mapped[str] = mapped_column(ForeignKey("billing_plan_versions.id"))
    lot_id: Mapped[str] = mapped_column(String(80), unique=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
