"""人工办理单、会员周期与额度批次读写，由上层统一控制事务。"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import func, insert, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql.selectable import Subquery

from app.modules.billing.dao.catalog_dao import current_version
from app.modules.billing.dao.change_dao import visible_changes
from app.modules.billing.dao.period_dao import available_totals, effective_plan
from app.modules.billing.entity.do.credit_do import CreditLotRow, LedgerEntryRow, WalletRow
from app.modules.billing.entity.do.operation_do import BillingOperationRow, BillingPeriodRow
from app.modules.billing.entity.do.plan_do import PlanVersionRow, SubscriptionRow
from app.modules.billing.entity.vo.operations import (
    BillingAccount,
    BillingAccounts,
    OperationInput,
    Quote,
)


async def listed_version(db: AsyncSession, key: str, now: datetime) -> PlanVersionRow | None:
    p = PlanVersionRow
    row = await db.get(p, key)
    if row is None:
        return None
    current = await current_version(db, row.sku, now)
    return current if current and current.id == key and current.listed else None


async def available(db: AsyncSession, owner: str, now: datetime) -> int:
    totals = available_totals(now).where(CreditLotRow.user_id == owner).subquery()
    return int(await db.scalar(select(totals.c.available)) or 0)


async def directory(
    db: AsyncSession,
    users: Subquery,
    now: datetime,
    search: str,
    state: str | None,
    sku: str | None,
    before: datetime | None,
    page: int,
    size: int,
    owners: list[str] | None,
) -> BillingAccounts:
    sub, plan = SubscriptionRow, PlanVersionRow
    tail = aliased(PlanVersionRow)
    query = (
        select(
            users.c.id,
            users.c.username,
            users.c.display_name,
            users.c.disabled,
            users.c.unlimited,
            sub.ends_at,
            sub.revision,
            tail.sku.label("last_booked_sku"),
            tail.name.label("last_booked_name"),
            plan.id.label("plan_id"),
            plan.sku.label("plan_sku"),
            plan.name.label("plan_name"),
        )
        .select_from(users)
        .outerjoin(sub, sub.user_id == users.c.id)
        .outerjoin(plan, plan.id == effective_plan(now))
        .outerjoin(tail, tail.id == effective_plan())
    )
    if owners is not None:
        query = query.where(users.c.id.in_(owners))
    if search:
        query = query.where(
            or_(
                users.c.username.icontains(search, autoescape=True),
                users.c.display_name.icontains(search, autoescape=True),
            )
        )
    if state == "active":
        query = query.where(sub.starts_at <= now, sub.ends_at > now)
    elif state == "expired":
        query = query.where(sub.ends_at <= now)
    elif state == "none":
        query = query.where(sub.user_id.is_(None))
    if sku:
        query = query.where(plan.sku == sku)
    if before:
        query = query.where(sub.ends_at > now, sub.ends_at <= before)
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    batch = (
        query.order_by(users.c.username, users.c.id)
        .offset((page - 1) * size)
        .limit(size)
        .subquery()
    )
    totals = available_totals(now).where(CreditLotRow.user_id.in_(select(batch.c.id))).subquery()
    result = await db.execute(
        select(batch, func.coalesce(totals.c.available, 0).label("available"))
        .outerjoin(totals, totals.c.user_id == batch.c.id)
        .order_by(batch.c.username, batch.c.id)
    )
    rows = result.all()
    changes = await visible_changes(db, [r.id for r in rows], now)
    return BillingAccounts(
        items=[
            BillingAccount(
                user_id=r.id,
                username=r.username,
                display_name=r.display_name,
                disabled=r.disabled,
                unlimited=r.unlimited,
                plan_id=r.plan_id,
                last_booked_sku=r.last_booked_sku,
                last_booked_name=r.last_booked_name,
                revision=r.revision or 0,
                plan_change=changes.get(r.id),
                plan_sku=r.plan_sku,
                plan_name=r.plan_name,
                ends_at=r.ends_at,
                available_points=r.available,
                state="none" if not r.ends_at else "active" if r.ends_at > now else "expired",
            )
            for r in rows
        ],
        total=int(total or 0),
    )


async def record_grant(
    db: AsyncSession,
    op: BillingOperationRow,
    body: OperationInput,
    quote: Quote,
    confirmed: datetime,
) -> None:
    owner, lot_id = op.user_id, str(uuid4())
    member = body.action in {"open", "renew"}
    kind = "membership_grant" if member else body.action
    source = f"{kind}:{op.id}"
    await db.execute(
        pg_insert(WalletRow)
        .values(user_id=owner, created_at=confirmed)
        .on_conflict_do_nothing(index_elements=["user_id"])
    )
    # 批次与流水的 created_at 均为生效时间；办理时间单独记录在原单。
    await db.execute(
        insert(CreditLotRow).values(
            id=lot_id,
            user_id=owner,
            source_key=source,
            granted=quote.points,
            remaining=quote.points,
            held=0,
            created_at=quote.starts_at,
            expires_at=quote.ends_at,
        )
    )
    await db.execute(
        insert(LedgerEntryRow).values(
            id=str(uuid4()),
            user_id=owner,
            lot_id=lot_id,
            kind=kind,
            event_key=source,
            available_delta=quote.points,
            held_delta=0,
            created_at=quote.starts_at,
        )
    )
    if member:
        sub = await db.get(SubscriptionRow, owner)
        if not sub:
            sub = SubscriptionRow(user_id=owner)
            db.add(sub)
        else:
            sub.revision += 1
        if body.action == "open":
            sub.starts_at = quote.starts_at
            sub.plan_version_id = str(body.plan_version_id)
            sub.plan_kind = "membership"
        sub.ends_at = quote.ends_at
        sub.next_grant_at = None
        db.add(
            BillingPeriodRow(
                operation_id=op.id,
                user_id=owner,
                plan_version_id=body.plan_version_id,
                lot_id=lot_id,
                starts_at=quote.starts_at,
                ends_at=quote.ends_at,
            )
        )
