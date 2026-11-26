"""跨期换档指令。已购办理单和额度批次由原事务持有。"""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class PlanChangeRow(Base):
    __tablename__ = "billing_subscription_changes"
    __table_args__ = (
        UniqueConstraint("actor_id", "business_key"),
        UniqueConstraint("cancelled_by", "cancel_key"),
        ForeignKeyConstraint(
            ["user_id", "booked_operation_id"],
            ["billing_operations.user_id", "billing_operations.id"],
        ),
        CheckConstraint("from_version_id <> to_version_id AND expected_revision > 0"),
        CheckConstraint(
            "(cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_key IS NULL "
            "AND cancel_reason IS NULL AND cancel_revision IS NULL) OR "
            "(cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_key IS NOT NULL "
            "AND cancel_reason IS NOT NULL AND cancel_revision IS NOT NULL AND cancel_revision > 0)"
        ),
        Index(
            "uq_billing_change_pending",
            "user_id",
            unique=True,
            postgresql_where=text("booked_operation_id IS NULL AND cancelled_at IS NULL"),
        ),
        Index("ix_billing_change_owner_time", "user_id", "created_at", "id"),
    )
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("billing_subscriptions.user_id"))
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    business_key: Mapped[str] = mapped_column(String(80))
    expected_revision: Mapped[int]
    from_version_id: Mapped[str] = mapped_column(ForeignKey("billing_plan_versions.id"))
    to_version_id: Mapped[str] = mapped_column(ForeignKey("billing_plan_versions.id"))
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str] = mapped_column(String(300))
    booked_operation_id: Mapped[str | None] = mapped_column(String(80), unique=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    cancel_key: Mapped[str | None] = mapped_column(String(80))
    cancel_revision: Mapped[int | None]
    cancel_reason: Mapped[str | None] = mapped_column(String(300))
    restores_change_id: Mapped[str | None] = mapped_column(
        ForeignKey("billing_subscription_changes.id"), unique=True
    )
