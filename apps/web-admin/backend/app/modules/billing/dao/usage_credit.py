"""制作任务按有效批次预留，按原任务和原批次结算；外部供应商调用始终在事务外。"""

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.billing.entity.do.credit_do import CreditLotRow, LedgerEntryRow


def entry(
    lot: CreditLotRow, key: str, kind: str, available: int, held: int, now: datetime
) -> LedgerEntryRow:
    return LedgerEntryRow(
        id=str(uuid4()),
        user_id=lot.user_id,
        lot_id=lot.id,
        event_key=key,
        kind=kind,
        available_delta=available,
        held_delta=held,
        created_at=now,
    )


async def reserve_jobs(db: AsyncSession, owner: str, charges: list[tuple[str, int]]) -> None:
    """调用方已锁定计划；余额不足时整批回滚，多个作品共享同一把账号锁。"""
    if any(points < 0 for _, points in charges):
        raise ValueError("制作报价不能为负数")
    required = sum(points for _, points in charges)
    if not required:
        return
    await lock_transaction(db, "billing:account:" + owner)
    now = datetime.now(UTC)
    lots = (
        await db.scalars(
            select(CreditLotRow)
            .where(
                CreditLotRow.user_id == owner,
                CreditLotRow.created_at <= now,
                CreditLotRow.expires_at > now,
                CreditLotRow.remaining > CreditLotRow.held,
            )
            .order_by(CreditLotRow.expires_at, CreditLotRow.id)
            .with_for_update()
        )
    ).all()
    available = sum(lot.remaining - lot.held for lot in lots)
    if available < required:
        raise DomainError(
            402,
            f"本次生成需要 {required} 创作点，当前可用 {available} 点，还差 {required - available} 点。",
            "insufficient_credits",
            context={"requiredPoints": required, "availablePoints": available},
        )
    index = 0
    for job, points in charges:
        while points:
            lot = lots[index]
            take = min(points, lot.remaining - lot.held)
            lot.held += take
            db.add(entry(lot, "reserve:" + job, "usage_hold", -take, take, now))
            points -= take
            if lot.held == lot.remaining:
                index += 1


async def finish_job(db: AsyncSession, owner: str, job: str, *, used: bool) -> bool:
    """同一任务的扣费和释放互斥；历史无预留任务不会追扣。"""
    await lock_transaction(db, "billing:account:" + owner)
    final_key = "finish:" + job
    previous = await db.scalar(
        select(LedgerEntryRow.kind)
        .where(LedgerEntryRow.user_id == owner, LedgerEntryRow.event_key == final_key)
        .limit(1)
    )
    if previous is not None:
        return previous == "usage_charge"
    allocations = (
        await db.execute(
            select(CreditLotRow, LedgerEntryRow.held_delta)
            .join(LedgerEntryRow, LedgerEntryRow.lot_id == CreditLotRow.id)
            .where(LedgerEntryRow.user_id == owner, LedgerEntryRow.event_key == "reserve:" + job)
            .order_by(CreditLotRow.expires_at, CreditLotRow.id)
            .with_for_update(of=CreditLotRow)
        )
    ).all()
    now = datetime.now(UTC)
    for lot, amount in allocations:
        lot.held -= amount
        if used:
            lot.remaining -= amount
        available = amount if not used and lot.expires_at > now else 0
        db.add(
            entry(
                lot, final_key, "usage_charge" if used else "usage_release", available, -amount, now
            )
        )
    return used
