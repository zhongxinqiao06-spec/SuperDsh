"""创作点钱包、发放批次与追加流水。点数均为整数，金额另由订单域记录。"""

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
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql.elements import ColumnElement

from app.infrastructure.database import Base


class WalletRow(Base):
    """同一用户跨产品共用钱包，余额以有效批次为准。"""

    __tablename__ = "billing_wallets"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CreditLotRow(Base):
    """每个来源事件生成一批额度，到期后剩余部分不再可用。"""

    __tablename__ = "billing_credit_lots"
    __table_args__ = (
        UniqueConstraint("user_id", "source_key"),
        UniqueConstraint("user_id", "id"),
        CheckConstraint(
            "granted > 0 AND remaining >= 0 AND held >= 0 AND held <= remaining AND remaining <= granted"
        ),
        Index("ix_billing_lots_owner_expiry", "user_id", "expires_at"),
    )
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("billing_wallets.user_id"))
    source_key: Mapped[str] = mapped_column(String(120))
    granted: Mapped[int]
    remaining: Mapped[int]
    held: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    card_name: Mapped[str | None] = mapped_column(String(80))
    card_image: Mapped[str | None] = mapped_column(String(180))
    weekly_limit: Mapped[int | None]
    monthly_limit: Mapped[int | None]
    notice_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @classmethod
    def is_card(cls) -> ColumnElement[bool]:
        """原单生成唯一 card: 来源，与历史钱包批次共用分摊和结算约束。"""
        return cls.source_key.startswith("card:")


class LedgerEntryRow(Base):
    """流水与本人批次关联，重放同一业务动作不能重复入账。"""

    __tablename__ = "billing_ledger_entries"
    __table_args__ = (
        ForeignKeyConstraint(
            ["user_id", "lot_id"], ["billing_credit_lots.user_id", "billing_credit_lots.id"]
        ),
        UniqueConstraint("user_id", "event_key", "lot_id"),
        Index("ix_billing_entries_owner_time", "user_id", "created_at", "id"),
    )
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(80))
    lot_id: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(32))
    event_key: Mapped[str] = mapped_column(String(120))
    available_delta: Mapped[int]
    held_delta: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
