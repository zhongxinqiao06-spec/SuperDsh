"""套餐读写使用同一商品锁，目录分页只读取每个商品的最新、当前与待生效版本。"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.infrastructure.database import lock_transaction
from app.modules.billing.entity.do.plan_do import PlanVersionRow
from app.modules.billing.entity.vo.catalog import (
    PlanDirectory,
    PlanRelease,
    PlanSeries,
    PublishPlan,
    ReleaseHistory,
)


async def by_key(
    db: AsyncSession, actor_id: str, key: str, *, withdrawal: bool = False
) -> PlanVersionRow | None:
    p = PlanVersionRow
    actor_col, key_col = (
        (p.withdrawn_by, p.withdraw_key) if withdrawal else (p.published_by, p.publish_key)
    )
    return await db.scalar(select(p).where(actor_col == actor_id, key_col == key))


async def by_revision(db: AsyncSession, sku: str, revision: int) -> PlanVersionRow | None:
    p = PlanVersionRow
    return await db.scalar(select(p).where(p.sku == sku, p.revision == revision))


async def append_version(
    db: AsyncSession, sku: str, actor_id: str, body: PublishPlan, now: datetime
) -> PlanVersionRow:
    row = PlanVersionRow(
        id=str(uuid4()),
        sku=sku,
        revision=body.expected_revision + 1,
        **body.terms(),
        effective_at=body.effective_at or now,
        published_at=now,
        published_by=actor_id,
        publish_key=str(body.business_key),
        publish_reason=body.reason,
    )
    db.add(row)
    await db.flush()
    return row


def record_withdrawal(
    row: PlanVersionRow, actor_id: str, key: str, reason: str, now: datetime
) -> None:
    row.withdrawn_at, row.withdrawn_by, row.withdraw_key, row.withdraw_reason = (
        now,
        actor_id,
        key,
        reason,
    )


async def lock_sku(db: AsyncSession, sku: str) -> None:
    await lock_transaction(db, "billing:catalog:" + sku)


async def lock_version_sku(db: AsyncSession, key: str) -> None:
    """先锁定不可变商品标识，再读取办理时刻与可售版本。"""
    sku = await db.scalar(select(PlanVersionRow.sku).where(PlanVersionRow.id == key))
    if sku is not None:
        await lock_sku(db, sku)


async def latest_version(db: AsyncSession, sku: str) -> PlanVersionRow | None:
    p = PlanVersionRow
    return await db.scalar(select(p).where(p.sku == sku).order_by(p.revision.desc()).limit(1))


async def current_version(db: AsyncSession, sku: str, now: datetime) -> PlanVersionRow | None:
    p = PlanVersionRow
    return await db.scalar(
        select(p)
        .where(p.sku == sku, p.effective_at <= now, p.withdrawn_at.is_(None))
        .order_by(p.effective_at.desc(), p.revision.desc())
        .limit(1)
    )


async def future_exists(db: AsyncSession, sku: str, now: datetime) -> bool:
    p = PlanVersionRow
    return bool(
        await db.scalar(
            select(p.id)
            .where(p.sku == sku, p.withdrawn_at.is_(None), p.effective_at > now)
            .limit(1)
        )
    )


async def directory(
    db: AsyncSession, search: str, page: int, size: int, now: datetime, exact: bool = False
) -> PlanDirectory:
    p = PlanVersionRow
    heads = select(p.sku, func.max(p.revision).label("rev")).group_by(p.sku)
    if search:
        heads = heads.where(p.sku == search if exact else p.sku.icontains(search, autoescape=True))
    total = int(await db.scalar(select(func.count()).select_from(heads.subquery())) or 0)
    batch = heads.order_by(p.sku).offset((page - 1) * size).limit(size).subquery()
    active, pending = aliased(p), aliased(p)
    eligible = select(p.id).where(p.sku == batch.c.sku, p.withdrawn_at.is_(None)).correlate(batch)
    current_id = (
        eligible.where(p.effective_at <= now)
        .order_by(p.effective_at.desc(), p.revision.desc())
        .limit(1)
        .scalar_subquery()
    )
    next_id = (
        eligible.where(p.effective_at > now)
        .order_by(p.effective_at, p.revision.desc())
        .limit(1)
        .scalar_subquery()
    )
    result = await db.execute(
        select(p, active, pending)
        .select_from(batch)
        .join(p, (p.sku == batch.c.sku) & (p.revision == batch.c.rev))
        .outerjoin(active, active.id == current_id)
        .outerjoin(pending, pending.id == next_id)
        .order_by(batch.c.sku)
    )
    return PlanDirectory(
        items=[
            PlanSeries(
                latest=PlanRelease.model_validate(latest),
                current=PlanRelease.model_validate(current) if current else None,
                upcoming=PlanRelease.model_validate(upcoming) if upcoming else None,
            )
            for latest, current, upcoming in result
        ],
        total=total,
    )


async def history(db: AsyncSession, sku: str, page: int, size: int) -> ReleaseHistory:
    p = PlanVersionRow
    total = int(await db.scalar(select(func.count()).select_from(p).where(p.sku == sku)) or 0)
    rows = await db.scalars(
        select(p)
        .where(p.sku == sku)
        .order_by(p.revision.desc())
        .offset((page - 1) * size)
        .limit(size)
    )
    return ReleaseHistory(items=[PlanRelease.model_validate(row) for row in rows], total=total)
