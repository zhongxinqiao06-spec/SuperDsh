"""注册入账写入同一调用方事务，依次落实外键依赖。"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.billing.entity.do.card_do import CardTypeRow
from app.modules.billing.entity.do.credit_do import CreditLotRow, LedgerEntryRow, WalletRow

REGISTRATION_CARD_SOURCE = "card:registration"


async def insert_registration_credit(
    session: AsyncSession, user_id: str, points: int, now: datetime, expires_at: datetime
) -> None:
    """新账号的钱包、注册批次和原始流水共享一个稳定来源键。"""
    design = (
        await session.execute(
            select(CardTypeRow.name, CardTypeRow.image)
            .where(CardTypeRow.enabled.is_(True), CardTypeRow.points == points)
            .order_by((CardTypeRow.id == "slate").desc(), CardTypeRow.id)
            .limit(1)
        )
    ).one_or_none()
    # 运营可下架或改价，注册权益固定为 200 点和 30 天。发放时独立冻结设计。
    name, image = (
        (design.name, design.image) if design else ("场记卡", "/images/credit-cards/slate.webp")
    )
    source_key = REGISTRATION_CARD_SOURCE
    lot_id = str(uuid4())
    await session.execute(insert(WalletRow).values(user_id=user_id, created_at=now))
    await session.execute(
        insert(CreditLotRow).values(
            id=lot_id,
            user_id=user_id,
            source_key=source_key,
            card_name=name,
            card_image=image,
            granted=points,
            remaining=points,
            held=0,
            created_at=now,
            expires_at=expires_at,
        )
    )
    await session.execute(
        insert(LedgerEntryRow).values(
            id=str(uuid4()),
            user_id=user_id,
            lot_id=lot_id,
            kind="registration_card",
            event_key=source_key,
            available_delta=points,
            held_delta=0,
            created_at=now,
        )
    )


async def unread_registration_card(session: AsyncSession, owner: str) -> CreditLotRow | None:
    """只有真实注册赠卡可触发提醒，运营发卡和历史普通注册赠额不会弹窗。"""
    return await session.scalar(
        select(CreditLotRow).where(
            CreditLotRow.user_id == owner,
            CreditLotRow.source_key == REGISTRATION_CARD_SOURCE,
            CreditLotRow.notice_seen_at.is_(None),
        )
    )


async def acknowledge_registration_card(
    session: AsyncSession, owner: str, lot_id: str, now: datetime
) -> None:
    """确认绑定当前认证账号和实际赠卡；并发确认只更新首次已读时间。"""
    await session.execute(
        update(CreditLotRow)
        .where(
            CreditLotRow.user_id == owner,
            CreditLotRow.id == lot_id,
            CreditLotRow.source_key == REGISTRATION_CARD_SOURCE,
            CreditLotRow.notice_seen_at.is_(None),
        )
        .values(notice_seen_at=now)
    )
