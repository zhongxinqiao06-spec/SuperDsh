"""账务只读仓储：账户过滤在 SQL 中完成，多项余额使用同一数据库快照。"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, or_, select, tuple_

from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.billing.dao.change_dao import visible_changes
from app.modules.billing.dao.member_quota import current_quota, spendable
from app.modules.billing.dao.period_dao import effective_plan, next_grant
from app.modules.billing.entity.do.credit_do import CreditLotRow, LedgerEntryRow
from app.modules.billing.entity.do.operation_do import BillingPeriodRow
from app.modules.billing.entity.do.plan_do import PlanVersionRow, SubscriptionRow
from app.modules.billing.entity.vo.dto import (
    BookedPlan,
    CreditCard,
    CreditCards,
    Entries,
    Entry,
    EntryDetail,
    Lot,
    Plan,
    Subscription,
    Wallet,
)


class MembershipRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def plans(self, now: datetime) -> list[Plan]:
        """每个商品先选当前生效的最新修订，再排除停售，避免旧版重新上架。"""
        p = PlanVersionRow
        ranked = (
            select(
                p.id,
                func.row_number()
                .over(partition_by=p.sku, order_by=(p.effective_at.desc(), p.revision.desc()))
                .label("position"),
            )
            .where(p.effective_at <= now, p.withdrawn_at.is_(None))
            .subquery()
        )
        async with self.database.sessions() as session:
            rows = await session.scalars(
                select(p)
                .join(ranked, ranked.c.id == p.id)
                .where(ranked.c.position == 1, p.listed.is_(True))
                .order_by(p.price_fen, p.sku)
            )
            return [Plan.model_validate(row) for row in rows]

    async def wallet(self, owner: str, now: datetime, days: int, lot_limit: int) -> Wallet:
        lot = CreditLotRow
        available = spendable(now)
        async with self.database.sessions() as session:
            await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            total, card_points, ordinary, held, expiring = (
                await session.execute(
                    select(
                        func.coalesce(func.sum(available), 0),
                        func.coalesce(func.sum(available).filter(lot.is_card()), 0),
                        func.coalesce(
                            func.sum(available).filter(lot.weekly_limit.is_(None), ~lot.is_card()),
                            0,
                        ),
                        func.coalesce(func.sum(lot.held), 0),
                        func.coalesce(
                            func.sum(
                                case(
                                    (lot.expires_at <= now + timedelta(days=days), available),
                                    else_=0,
                                )
                            ),
                            0,
                        ),
                    ).where(lot.user_id == owner, lot.created_at <= now)
                )
            ).one()
            rows = (
                await session.execute(
                    select(lot, available)
                    .where(
                        lot.user_id == owner,
                        lot.created_at <= now,
                        or_(available > 0, lot.held > 0),
                    )
                    .order_by(lot.expires_at, lot.id)
                    .limit(lot_limit + 1)
                )
            ).all()
            sub = SubscriptionRow
            current = (
                await session.execute(
                    select(sub, PlanVersionRow)
                    .select_from(sub)
                    .join(PlanVersionRow, PlanVersionRow.id == effective_plan(now))
                    .where(sub.user_id == owner, sub.starts_at <= now, sub.ends_at > now)
                )
            ).one_or_none()
            subscription = None
            if current:
                period, plan = current
                following = (
                    await session.execute(
                        select(PlanVersionRow.name, BillingPeriodRow.starts_at)
                        .select_from(BillingPeriodRow)
                        .join(PlanVersionRow, PlanVersionRow.id == BillingPeriodRow.plan_version_id)
                        .where(
                            BillingPeriodRow.user_id == owner,
                            BillingPeriodRow.starts_at > now,
                            BillingPeriodRow.starts_at < period.ends_at,
                            PlanVersionRow.sku != plan.sku,
                        )
                        .order_by(BillingPeriodRow.starts_at)
                        .limit(1)
                    )
                ).one_or_none()
                subscription = Subscription(
                    next_booked_plan=BookedPlan(name=following.name, starts_at=following.starts_at)
                    if following
                    else None,
                    plan=Plan.model_validate(plan),
                    starts_at=period.starts_at,
                    ends_at=period.ends_at,
                    next_grant_at=await session.scalar(next_grant(owner, now))
                    or (
                        period.next_grant_at
                        if period.next_grant_at and period.next_grant_at > now
                        else None
                    ),
                )
            return Wallet(
                plan_change=(await visible_changes(session, [owner], now)).get(owner),
                as_of=now,
                quota=await current_quota(session, owner, now),
                ordinary_points=ordinary,
                available_points=total,
                card_points=card_points,
                held_points=held,
                expiring_points=expiring,
                expiring_days=days,
                subscription=subscription,
                has_more_lots=len(rows) > lot_limit,
                lots=[
                    Lot(
                        id=r.id,
                        source_key=r.source_key,
                        granted=r.granted,
                        held=r.held,
                        available_points=can_use,
                        expires_at=r.expires_at,
                    )
                    for r, can_use in rows[:lot_limit]
                ],
            )

    async def cards(self, owner: str, now: datetime, page: int, size: int) -> CreditCards:
        """仅查询本人的卡，保留过期、用尽或仍在结算中的历史卡。"""
        lot = CreditLotRow
        async with self.database.sessions() as session:
            rows = (
                await session.scalars(
                    select(lot)
                    .where(lot.user_id == owner, lot.is_card(), lot.created_at <= now)
                    .order_by(
                        (lot.expires_at > now).desc(),
                        (lot.remaining > 0).desc(),
                        lot.created_at.desc(),
                        lot.id,
                    )
                    .offset((page - 1) * size)
                    .limit(size + 1)
                )
            ).all()
            items = []
            for row in rows[:size]:
                available = row.remaining - row.held if row.expires_at > now else 0
                items.append(
                    CreditCard(
                        id=row.id,
                        granted=row.granted,
                        name=row.card_name,
                        image=row.card_image,
                        available_points=available,
                        used_points=row.granted - row.remaining,
                        held=row.held,
                        issued_at=row.created_at,
                        expires_at=row.expires_at,
                        status="available"
                        if available
                        else "held"
                        if row.held
                        else "spent"
                        if row.remaining == 0
                        else "expired",
                    )
                )
            return CreditCards(items=items, has_more=len(rows) > size)

    async def entries(
        self,
        owner: str,
        cursor: str | None,
        limit: int,
        kind: str | None,
        since: datetime | None,
        until: datetime | None,
    ) -> Entries:
        """同刻流水按主键稳定排序，游标只接受当前账号同一筛选内的流水。"""
        entry = LedgerEntryRow
        scoped = select(entry).where(entry.user_id == owner, entry.created_at <= datetime.now(UTC))
        if kind:
            scoped = scoped.where(entry.kind == kind)
        if since:
            scoped = scoped.where(entry.created_at >= since)
        if until:
            scoped = scoped.where(entry.created_at < until)
        async with self.database.sessions() as session:
            if cursor:
                anchor = await session.scalar(scoped.where(entry.id == cursor))
                if anchor is None:
                    raise DomainError(422, "invalid billing cursor")
                scoped = scoped.where(
                    tuple_(entry.created_at, entry.id) < (anchor.created_at, anchor.id)
                )
            rows = (
                await session.scalars(
                    scoped.order_by(entry.created_at.desc(), entry.id.desc()).limit(limit + 1)
                )
            ).all()
            return Entries(
                items=[Entry.model_validate(r) for r in rows[:limit]],
                next_cursor=rows[limit - 1].id if len(rows) > limit else None,
            )

    async def detail(self, owner: str, entry_id: str) -> EntryDetail:
        async with self.database.sessions() as session:
            e, lot = LedgerEntryRow, CreditLotRow
            row = (
                await session.execute(
                    select(e, lot)
                    .join(lot, (lot.id == e.lot_id) & (lot.user_id == e.user_id))
                    .where(e.id == entry_id, e.user_id == owner, e.created_at <= datetime.now(UTC))
                )
            ).one_or_none()
            if row is None:
                raise DomainError(404, "billing entry not found")
            entry, batch = row
            return EntryDetail(
                **Entry.model_validate(entry).model_dump(),
                lot_id=batch.id,
                source_key=batch.source_key,
                granted=batch.granted,
                expires_at=batch.expires_at,
            )
