"""下期换档使用与续期相同的账号锁，已购原单、已确认实收及发放批次不可改写。"""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.billing.dao import change_dao
from app.modules.billing.dao.catalog_dao import lock_version_sku
from app.modules.billing.dao.operations_dao import listed_version
from app.modules.billing.entity.do.change_do import PlanChangeRow
from app.modules.billing.entity.do.plan_do import SubscriptionRow
from app.modules.billing.entity.vo.changes import (
    ChangeCommand,
    ChangeHistory,
    ChangeRecord,
    ScheduleInput,
)
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.billing_directory import require_billing_customer


class PlanChanges:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def history(self, actor: Account, owner: str, page: int, size: int) -> ChangeHistory:
        actor.require("billing.read")
        async with self.database.sessions() as db:
            return await change_dao.history(db, owner, datetime.now(UTC), page, size)

    async def lock(self, db: AsyncSession, actor: Account, owner: str, key: str) -> None:
        actor.require("billing.read")
        actor.require("billing.subscriptions.manage")
        await lock_transaction(db, f"billing:change-key:{actor.user_id}:{key}")
        await lock_transaction(db, "billing:account:" + owner)

    async def schedule(self, actor: Account, owner: str, body: ScheduleInput) -> ChangeRecord:
        key = str(body.business_key)
        async with self.database.sessions.begin() as db:
            await self.lock(db, actor, owner, key)
            await lock_version_sku(db, body.plan_version_id)
            now = datetime.now(UTC)
            c = PlanChangeRow
            previous = await db.scalar(
                select(c).where(c.actor_id == actor.user_id, c.business_key == key)
            )
            if previous:
                if (
                    previous.user_id,
                    previous.to_version_id,
                    previous.reason,
                    previous.expected_revision,
                ) != (owner, body.plan_version_id, body.reason, body.expected_revision):
                    raise DomainError(409, "该业务号已用于其他换档请求")
                return await change_dao.describe(db, previous, now)
            sub = await db.get(SubscriptionRow, owner)
            if not sub or not sub.starts_at <= now < sub.ends_at:
                raise DomainError(409, "仅有效会员可预约下期换档")
            if sub.revision != body.expected_revision:
                raise DomainError(409, "会员已变更，请刷新后重新选择")
            await require_billing_customer(db, owner)
            if await change_dao.pending(db, owner):
                raise DomainError(409, "已有待办理换档，请先撤销原预约")
            target = await listed_version(db, body.plan_version_id, now)
            source = await change_dao.tail_plan(db, owner)
            if not target or target.kind != "membership" or target.sku == source.sku:
                raise DomainError(422, "请选择与已购末期不同的在售会员档位")
            row = await change_dao.add_change(
                db,
                owner,
                actor.user_id,
                key,
                sub.revision,
                source.id,
                target.id,
                sub.ends_at,
                now,
                body.reason,
            )
            sub.revision += 1
            return await change_dao.describe(db, row, now)

    async def cancel(
        self, actor: Account, owner: str, change_id: str, body: ChangeCommand
    ) -> ChangeRecord:
        key = str(body.business_key)
        async with self.database.sessions.begin() as db:
            await self.lock(db, actor, owner, key)
            now = datetime.now(UTC)
            c = PlanChangeRow
            replay = await db.scalar(
                select(c).where(c.cancelled_by == actor.user_id, c.cancel_key == key)
            )
            if replay:
                if (replay.id, replay.user_id, replay.cancel_reason, replay.cancel_revision) != (
                    change_id,
                    owner,
                    body.reason,
                    body.expected_revision,
                ):
                    raise DomainError(409, "该业务号已用于其他撤销请求")
                return await change_dao.describe(db, replay, now)
            row = await db.scalar(select(c).where(c.id == change_id, c.user_id == owner))
            if not row:
                raise DomainError(404, "换档记录不存在")
            sub = await db.get(SubscriptionRow, owner)
            if not row.cancelled_at and row.booked_operation_id and now >= row.effective_at:
                raise DomainError(
                    409, "该档位已生效，请查看当前会员并预约新的周期", "plan_change_effective"
                )
            if not sub or sub.revision != body.expected_revision or row.cancelled_at:
                raise DomainError(409, "预约已变化，请刷新后查看当前会员")
            if row.booked_operation_id:
                visible = (await change_dao.visible_changes(db, [owner], now)).get(owner)
                if not visible or visible.id != row.id:
                    raise DomainError(409, "已有更晚的换档，请先核对最新预约")
                tail = await change_dao.tail_plan(db, owner)
                if tail.sku != visible.to_plan_sku:
                    raise DomainError(409, "后续已有不同的已购档位，请从会员列表办理最新预约")
                # 已购权益仍从原日期生效，恢复原档只作用于首个未购周期。
                await change_dao.add_change(
                    db,
                    owner,
                    actor.user_id,
                    "restore:" + row.id,
                    sub.revision,
                    tail.id,
                    row.from_version_id,
                    sub.ends_at,
                    now,
                    body.reason,
                    restores=row.id,
                )
            row.cancelled_at, row.cancelled_by, row.cancel_key, row.cancel_reason = (
                now,
                actor.user_id,
                key,
                body.reason,
            )
            row.cancel_revision = body.expected_revision
            sub.revision += 1
            return await change_dao.describe(db, row, now)
