"""卡种目录与冻结选择，同一行的发放和编辑串行。"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.billing.entity.do.card_do import CardTypeRow
from app.modules.billing.entity.vo.cards import CardType


async def types(db: AsyncSession, enabled_only: bool) -> list[CardType]:
    q = select(CardTypeRow)
    if enabled_only:
        q = q.where(CardTypeRow.enabled.is_(True))
    rows = await db.scalars(q.order_by(CardTypeRow.points, CardTypeRow.id))
    return [CardType.model_validate(x) for x in rows]


async def issue_options(db: AsyncSession, key: str | None, points: int | None) -> list[CardTypeRow]:
    row = CardTypeRow
    q = select(row).where(row.enabled.is_(True), row.id == key if key else row.points == points)
    return list(await db.scalars(q.limit(2).with_for_update(read=True)))
