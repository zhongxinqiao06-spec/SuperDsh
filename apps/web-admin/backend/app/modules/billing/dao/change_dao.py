"""换档查询限定所属账号；有效时间、原单与撤销证据共同决定展示状态。"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.modules.billing.dao.period_dao import effective_plan
from app.modules.billing.entity.do.change_do import PlanChangeRow
from app.modules.billing.entity.do.plan_do import PlanVersionRow, SubscriptionRow
from app.modules.billing.entity.vo.changes import (
    ChangeHistory,
    ChangeRecord,
    ChangeState,
    ChangeSummary,
)


async def tail_plan(db: AsyncSession, owner: str) -> PlanVersionRow:
    """取已购序列最后一档，兼容只有早期会员快照的账号。"""
    return (
        await db.scalars(
            select(PlanVersionRow)
            .select_from(SubscriptionRow)
            .join(PlanVersionRow, PlanVersionRow.id == effective_plan())
            .where(SubscriptionRow.user_id == owner)
        )
    ).one()


async def pending(db: AsyncSession, owner: str) -> PlanChangeRow | None:
    c = PlanChangeRow
    return await db.scalar(
        select(c).where(
            c.user_id == owner, c.cancelled_at.is_(None), c.booked_operation_id.is_(None)
        )
    )


async def add_change(
    db: AsyncSession,
    owner: str,
    actor: str,
    key: str,
    revision: int,
    source: str,
    target: str,
    start: datetime,
    now: datetime,
    reason: str,
    restores: str | None = None,
) -> PlanChangeRow:
    row = PlanChangeRow(
        id=str(uuid4()),
        user_id=owner,
        actor_id=actor,
        business_key=key,
        expected_revision=revision,
        from_version_id=source,
        to_version_id=target,
        effective_at=start,
        created_at=now,
        reason=reason,
        restores_change_id=restores,
    )
    db.add(row)
    await db.flush()
    return row


def summary(
    c: PlanChangeRow, old: PlanVersionRow, new: PlanVersionRow, now: datetime
) -> ChangeSummary:
    state: ChangeState
    if c.cancelled_at:
        state = "cancelled"
    elif c.booked_operation_id:
        state = "booked" if c.effective_at > now else "effective"
    else:
        state = "scheduled" if c.effective_at > now else "due"
    return ChangeSummary(
        id=c.id,
        from_plan_name=old.name,
        from_plan_sku=old.sku,
        to_plan_name=new.name,
        to_plan_sku=new.sku,
        to_version_id=new.id,
        price_fen=new.price_fen,
        points=new.points,
        effective_at=c.effective_at,
        state=state,
    )


def record(
    c: PlanChangeRow, old: PlanVersionRow, new: PlanVersionRow, now: datetime
) -> ChangeRecord:
    return ChangeRecord(
        **summary(c, old, new, now).model_dump(),
        created_at=c.created_at,
        actor_id=c.actor_id,
        reason=c.reason,
        booked_operation_id=c.booked_operation_id,
        cancelled_at=c.cancelled_at,
        cancelled_by=c.cancelled_by,
        cancel_reason=c.cancel_reason,
        restores_change_id=c.restores_change_id,
    )


async def describe(db: AsyncSession, row: PlanChangeRow, now: datetime) -> ChangeRecord:
    old = await db.get(PlanVersionRow, row.from_version_id)
    new = await db.get(PlanVersionRow, row.to_version_id)
    assert old is not None and new is not None
    return record(row, old, new, now)


async def visible_changes(
    db: AsyncSession, owners: list[str], now: datetime
) -> dict[str, ChangeSummary]:
    """每位账号只取一条，先列未办理预约，再列最近办理且周期尚未开始的换档。"""
    if not owners:
        return {}
    c = PlanChangeRow
    ranked = (
        select(
            c.id,
            func.row_number()
            .over(
                partition_by=c.user_id,
                order_by=(
                    case((c.booked_operation_id.is_(None), 0), else_=1),
                    c.effective_at.desc(),
                    c.created_at.desc(),
                    c.id.desc(),
                ),
            )
            .label("pos"),
        )
        .where(
            c.user_id.in_(owners),
            c.cancelled_at.is_(None),
            or_(c.booked_operation_id.is_(None), c.effective_at > now),
        )
        .subquery()
    )
    old, new = aliased(PlanVersionRow), aliased(PlanVersionRow)
    rows = await db.execute(
        select(c, old, new)
        .select_from(c)
        .join(ranked, ranked.c.id == c.id)
        .join(old, old.id == c.from_version_id)
        .join(new, new.id == c.to_version_id)
        .where(ranked.c.pos == 1)
    )
    return {change.user_id: summary(change, source, target, now) for change, source, target in rows}


async def history(
    db: AsyncSession, owner: str, now: datetime, page: int, size: int
) -> ChangeHistory:
    c = PlanChangeRow
    old, new = aliased(PlanVersionRow), aliased(PlanVersionRow)
    rows = (
        await db.execute(
            select(c, old, new)
            .select_from(c)
            .join(old, old.id == c.from_version_id)
            .join(new, new.id == c.to_version_id)
            .where(c.user_id == owner)
            .order_by(c.created_at.desc(), c.id.desc())
            .offset((page - 1) * size)
            .limit(size + 1)
        )
    ).all()
    return ChangeHistory(
        items=[record(r, a, b, now) for r, a, b in rows[:size]], has_more=len(rows) > size
    )
