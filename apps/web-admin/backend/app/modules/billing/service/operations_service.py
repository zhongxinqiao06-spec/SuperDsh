"""人工办理先冻结预览，确认时重新校验。原单、周期、账本在一个短事务内提交。"""

from calendar import monthrange
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.billing.dao import change_dao
from app.modules.billing.dao import operations_dao as dao
from app.modules.billing.dao.catalog_dao import lock_version_sku
from app.modules.billing.dao.membership_dao import MembershipRepository
from app.modules.billing.entity.do.change_do import PlanChangeRow
from app.modules.billing.entity.do.operation_do import BillingOperationRow
from app.modules.billing.entity.do.plan_do import SubscriptionRow
from app.modules.billing.entity.vo.dto import CreditCards, Wallet
from app.modules.billing.entity.vo.operations import (
    BillingAccounts,
    Operation,
    OperationHistory,
    OperationInput,
    OperationRecord,
    Quote,
)
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.billing_directory import (
    account_directory,
    require_billing_customer,
)


def cycle_end(start: datetime, months: int, anchor_day: int) -> datetime:
    """保留开通的日历锚点，1 月 31 日的两次月结落在 2 月末和 3 月 31 日。"""
    year, month = divmod(start.year * 12 + start.month - 1 + months, 12)
    month += 1
    return start.replace(year=year, month=month, day=min(anchor_day, monthrange(year, month)[1]))


def permissions(actor: Account, body: OperationInput) -> None:
    actor.require("billing.read")
    actor.require(
        "billing.subscriptions.manage"
        if body.action in {"open", "renew"}
        else "billing.adjustments.create"
    )
    if body.payment == "offline":
        actor.require("billing.receipts.record")


def view(row: BillingOperationRow) -> Operation:
    return Operation(
        id=row.id,
        user_id=row.user_id,
        quote=Quote.model_validate(row.quote),
        expires_at=row.created_at + timedelta(minutes=15),
        confirmed_at=row.confirmed_at,
    )


class BillingOperations:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def accounts(
        self,
        actor: Account,
        search: str,
        state: str | None,
        sku: str | None,
        expiring_days: int | None,
        page: int,
        size: int,
        owner: str | None,
    ) -> BillingAccounts:
        actor.require("billing.read")
        now = datetime.now(UTC)
        async with self.database.sessions() as db:
            await db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            return await dao.directory(
                db,
                account_directory(),
                now,
                search,
                state,
                sku,
                now + timedelta(days=expiring_days) if expiring_days else None,
                page,
                size,
                [owner] if owner else None,
            )

    async def user_summaries(
        self, actor: Account, owners: list[str]
    ) -> dict[str, dict[str, object]]:
        """仅查询用户管理当前页，账号管理资格与跨用户账务读取资格分别判断。"""
        actor.require("billing.read")
        if not owners:
            return {}
        async with self.database.sessions() as db:
            await db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            batch = await dao.directory(
                db,
                account_directory(),
                datetime.now(UTC),
                "",
                None,
                None,
                None,
                1,
                len(owners),
                owners,
            )
            return {
                item.user_id: item.model_dump(by_alias=True, mode="json") for item in batch.items
            }

    async def summary(self, actor: Account, owner: str) -> Wallet:
        """运营查看指定账号的余额、占用、最近到期批次与下期发放。"""
        actor.require("billing.read")
        accounts = await self.accounts(actor, "", None, None, None, 1, 1, owner)
        if not accounts.total:
            raise DomainError(404, "账号不存在")
        wallet = await MembershipRepository(self.database).wallet(owner, datetime.now(UTC), 7, 20)
        wallet.unlimited = accounts.items[0].unlimited
        return wallet

    async def cards(self, actor: Account, owner: str, page: int, size: int) -> CreditCards:
        """运营按账号核对已发卡和剩余额度，沿用个人页的卡状态口径。"""
        actor.require("billing.read")
        return await MembershipRepository(self.database).cards(owner, datetime.now(UTC), page, size)

    async def history(self, actor: Account, owner: str, page: int, size: int) -> OperationHistory:
        actor.require("billing.read")
        r = BillingOperationRow
        async with self.database.sessions() as db:
            rows = (
                await db.scalars(
                    select(r)
                    .where(r.user_id == owner, r.confirmed_at.is_not(None))
                    .order_by(r.confirmed_at.desc(), r.id.desc())
                    .offset((page - 1) * size)
                    .limit(size + 1)
                )
            ).all()
            return OperationHistory(
                has_more=len(rows) > size,
                items=[
                    OperationRecord(
                        **view(row).model_dump(),
                        actor_id=row.actor_id,
                        receipt=row.receipt
                        if "billing.receipts.record" in actor.permissions
                        else None,
                        reason=row.request["reason"],
                        payment=row.request["payment"],
                    )
                    for row in rows[:size]
                ],
            )

    async def quote(
        self, db: AsyncSession, body: OperationInput, base: datetime, now: datetime
    ) -> Quote:
        username = await require_billing_customer(db, body.user_id)
        balance = await dao.available(db, body.user_id, now)
        sub = await db.get(SubscriptionRow, body.user_id)
        active = bool(sub and sub.starts_at <= now < sub.ends_at)
        start = base
        points = body.points or 0
        price = 0
        name = None
        change = None
        if body.plan_version_id:
            plan = await dao.listed_version(db, body.plan_version_id, now)
            if not plan or plan.kind != ("addon" if body.action == "topup" else "membership"):
                raise DomainError(409, "商品版本已变更，请重新选择")
            points, price, name = plan.points, plan.price_fen, plan.name
            anchor = start.day
            if body.action == "open" and active:
                raise DomainError(409, "该账号已有有效会员，请选择续期")
            if body.action in {"open", "renew"}:
                change = await change_dao.pending(db, body.user_id)
                if change and (
                    change.to_version_id != plan.id or (sub and change.effective_at != sub.ends_at)
                ):
                    raise DomainError(409, "预约已变化，请刷新后按预约档位办理")
            if body.action == "renew":
                if not sub or not active:
                    raise DomainError(409, "当前会员已到期，请重新开通")
                if not change and (await change_dao.tail_plan(db, body.user_id)).sku != plan.sku:
                    raise DomainError(409, "续期须选择已购末期档位，换档请先预约")
                start, anchor = sub.ends_at, sub.starts_at.day
            end = cycle_end(start, 12 if plan.term_unit == "year" else 1, anchor)
        else:
            end = start + timedelta(days=body.valid_days or 0)
        if body.payment == "offline" and body.received_fen != price:
            raise DomainError(422, "实收金额须与当前商品价格一致")
        immediate = 0 if body.action == "renew" else points
        return Quote(
            plan_change_id=change.id if change else None,
            username=username,
            action=body.action,
            plan_name=name,
            price_fen=price,
            received_fen=body.received_fen or 0,
            points=points,
            immediate_points=immediate,
            available_before=balance,
            available_after=balance + immediate,
            starts_at=start,
            ends_at=end,
            previous_end=sub.ends_at if sub and body.action in {"open", "renew"} else None,
        )

    async def preview(self, actor: Account, body: OperationInput) -> Operation:
        permissions(actor, body)
        request = body.model_dump(mode="json")
        async with self.database.sessions.begin() as db:
            await lock_transaction(db, f"billing:key:{actor.user_id}:{body.business_key}")
            row = await db.scalar(
                select(BillingOperationRow).where(
                    BillingOperationRow.actor_id == actor.user_id,
                    BillingOperationRow.business_key == str(body.business_key),
                )
            )
            if row:
                if row.request != request:
                    raise DomainError(409, "同一业务号的办理内容不能修改")
                return view(row)
            now = datetime.now(UTC)
            quote = await self.quote(db, body, now, now)
            row = BillingOperationRow(
                id=str(uuid4()),
                user_id=body.user_id,
                actor_id=actor.user_id,
                business_key=str(body.business_key),
                request=request,
                quote=quote.model_dump(mode="json"),
                created_at=now,
            )
            db.add(row)
            return view(row)

    async def confirm(self, actor: Account, key: str, membership: bool) -> Operation:
        actor.require("billing.read")
        async with self.database.sessions.begin() as db:
            row = await db.scalar(
                select(BillingOperationRow)
                .where(BillingOperationRow.id == key, BillingOperationRow.actor_id == actor.user_id)
                .with_for_update()
            )
            if not row:
                raise DomainError(404, "办理预览不存在")
            body = OperationInput.model_validate(row.request)
            permissions(actor, body)
            if membership != (body.action in {"open", "renew"}):
                raise DomainError(422, "办理类型与入口不符")
            if row.confirmed_at:
                return view(row)
            await lock_transaction(db, "billing:account:" + body.user_id)
            if body.plan_version_id:
                await lock_version_sku(db, body.plan_version_id)
            now = datetime.now(UTC)
            if now >= view(row).expires_at:
                raise DomainError(409, "预览已过期，请重新预览")
            quote = await self.quote(db, body, row.created_at, now)
            if quote != view(row).quote:
                raise DomainError(409, "余额、商品或会员周期已变化，请重新预览")
            if body.receipt:
                await lock_transaction(db, "billing:receipt:" + body.receipt)
                if await db.scalar(
                    select(BillingOperationRow.id).where(
                        BillingOperationRow.receipt == body.receipt
                    )
                ):
                    raise DomainError(409, "该收款凭证已登记")
                row.receipt = body.receipt
            await dao.record_grant(db, row, body, quote, now)
            if quote.plan_change_id:
                change = await db.get(PlanChangeRow, quote.plan_change_id)
                assert change is not None
                change.booked_operation_id = row.id
            row.confirmed_at = now
            return view(row)
