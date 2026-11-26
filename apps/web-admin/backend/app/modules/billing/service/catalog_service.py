"""商品版本只追加。发布、撤回与会员确认在同一商品上串行，已购权益始终引用原版本。"""

from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.billing.dao import catalog_dao as dao
from app.modules.billing.entity.vo.catalog import (
    CatalogCommand,
    PlanDirectory,
    PlanRelease,
    PublishPlan,
    ReleaseHistory,
)
from app.modules.identity.entity.bo.models import Account


class CatalogManagement:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def directory(
        self, actor: Account, search: str, page: int, size: int, exact: bool = False
    ) -> PlanDirectory:
        actor.require("billing.read")
        async with self.database.sessions() as db:
            await db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            return await dao.directory(db, search, page, size, datetime.now(UTC), exact)

    async def history(self, actor: Account, sku: str, page: int, size: int) -> ReleaseHistory:
        actor.require("billing.read")
        async with self.database.sessions() as db:
            await db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            return await dao.history(db, sku, page, size)

    async def lock(self, db: AsyncSession, actor: Account, sku: str, key: str) -> None:
        actor.require("billing.read")
        actor.require("billing.plans.manage")
        await lock_transaction(db, f"billing:catalog-key:{actor.user_id}:{key}")
        await dao.lock_sku(db, sku)

    async def publish(self, actor: Account, sku: str, body: PublishPlan) -> PlanRelease:
        async with self.database.sessions.begin() as db:
            return await self.publish_in(db, actor, sku, body)

    async def publish_in(
        self, db: AsyncSession, actor: Account, sku: str, body: PublishPlan
    ) -> PlanRelease:
        """草稿与发布记录共用一个事务，沿用直接发布的并发检查。"""
        key = str(body.business_key)
        await self.lock(db, actor, sku, key)
        row = await dao.by_key(db, actor.user_id, key)
        terms = body.terms()
        if row:
            if (
                row.sku != sku
                or row.revision != body.expected_revision + 1
                or row.publish_reason != body.reason
                or row.effective_at != (body.effective_at or row.published_at)
                or any(getattr(row, k) != v for k, v in terms.items())
            ):
                raise DomainError(409, "业务号已用于其他发布请求")
            return PlanRelease.model_validate(row)
        latest = await dao.latest_version(db, sku)
        if body.expected_revision != (latest.revision if latest else 0):
            raise DomainError(409, "商品版本已变化，请刷新目录后核对")
        if latest and latest.kind != body.kind:
            raise DomainError(422, "同一商品不能变更类型")
        if not latest and not body.listed:
            raise DomainError(422, "新商品的首个版本须上架")
        now = datetime.now(UTC)
        if body.effective_at and body.effective_at <= now:
            raise DomainError(422, "定时发布须选择未来时间")
        if await dao.future_exists(db, sku, now):
            raise DomainError(409, "已有待生效版本，请先撤回或等待它生效")
        current = await dao.current_version(db, sku, now)
        if current and all(getattr(current, k) == v for k, v in terms.items()):
            raise DomainError(422, "商品条款与当前版本相同")
        row = await dao.append_version(db, sku, actor.user_id, body, now)
        return PlanRelease.model_validate(row)

    async def withdraw(
        self, actor: Account, sku: str, revision: int, body: CatalogCommand
    ) -> PlanRelease:
        key = str(body.business_key)
        async with self.database.sessions.begin() as db:
            await self.lock(db, actor, sku, key)
            previous = await dao.by_key(db, actor.user_id, key, withdrawal=True)
            if previous:
                if (previous.sku, previous.revision, previous.withdraw_reason) != (
                    sku,
                    revision,
                    body.reason,
                ):
                    raise DomainError(409, "业务号已用于其他撤回请求")
                return PlanRelease.model_validate(previous)
            row = await dao.by_revision(db, sku, revision)
            if not row:
                raise DomainError(404, "商品版本不存在")
            now = datetime.now(UTC)
            if row.withdrawn_at or row.effective_at <= now:
                raise DomainError(409, "版本已撤回或已生效，请刷新目录后核对")
            dao.record_withdrawal(row, actor.user_id, key, body.reason, now)
            return PlanRelease.model_validate(row)
