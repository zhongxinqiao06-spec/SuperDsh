"""已发布方案版本与账户会员周期，历史权益绑定购买时的版本。"""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class PlanVersionRow(Base):
    """同一商品按修订和生效时间发布，金额以人民币分保存。"""

    __tablename__ = "billing_plan_versions"
    __table_args__ = (
        UniqueConstraint("sku", "revision"),
        UniqueConstraint("published_by", "publish_key", name="uq_plan_publish_key"),
        UniqueConstraint("withdrawn_by", "withdraw_key", name="uq_plan_withdraw_key"),
        CheckConstraint(
            "num_nonnulls(published_at,published_by,publish_key,publish_reason) IN (0,4) "
            "AND (published_at IS NULL OR published_at <= effective_at)",
            name="ck_plan_publish_evidence",
        ),
        CheckConstraint(
            "num_nonnulls(withdrawn_at,withdrawn_by,withdraw_key,withdraw_reason) IN (0,4) "
            "AND (withdrawn_at IS NULL OR withdrawn_at < effective_at)",
            name="ck_plan_withdraw_evidence",
        ),
        UniqueConstraint("id", "kind"),
        CheckConstraint("revision > 0 AND price_fen >= 0 AND points > 0"),
        CheckConstraint("kind IN ('membership', 'addon') AND term_unit IN ('month', 'year')"),
    )
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    sku: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int]
    name: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(16))
    term_unit: Mapped[str] = mapped_column(String(16))
    price_fen: Mapped[int]
    points: Mapped[int]
    weekly_points: Mapped[int | None]
    listed: Mapped[bool]
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    publish_key: Mapped[str | None] = mapped_column(String(36))
    publish_reason: Mapped[str | None] = mapped_column(String(300))
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    withdrawn_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    withdraw_key: Mapped[str | None] = mapped_column(String(36))
    withdraw_reason: Mapped[str | None] = mapped_column(String(300))


class SubscriptionRow(Base):
    """账号当前会员周期快照；加购版本不能挂到会员周期。"""

    __tablename__ = "billing_subscriptions"
    __table_args__ = (
        ForeignKeyConstraint(
            ["plan_version_id", "plan_kind"],
            ["billing_plan_versions.id", "billing_plan_versions.kind"],
        ),
        CheckConstraint("plan_kind = 'membership' AND starts_at < ends_at"),
        CheckConstraint(
            "next_grant_at IS NULL OR (next_grant_at >= starts_at AND next_grant_at <= ends_at)"
        ),
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    revision: Mapped[int] = mapped_column(default=1, server_default="1")
    plan_version_id: Mapped[str] = mapped_column(String(80))
    plan_kind: Mapped[str] = mapped_column(String(16))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    next_grant_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
