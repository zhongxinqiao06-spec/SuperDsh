"""商品草稿与费率发布。业务号负责重试，版本负责并发，已发布内容不可修改。"""

from datetime import UTC, datetime
from uuid import uuid4

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.billing.dao import pricing_dao as dao
from app.modules.billing.dao.catalog_dao import latest_version
from app.modules.billing.entity.do.pricing_do import PricingVersion
from app.modules.billing.entity.vo.catalog import PublishPlan
from app.modules.billing.entity.vo.pricing import PlanDraft, PublishDraft, RateDraft
from app.modules.billing.service.catalog_service import CatalogManagement
from app.modules.identity.entity.bo.models import Account


class PricingManagement:
    def __init__(self, database: Database) -> None:
        self.db = database
        self.catalog = CatalogManagement(database)

    async def directory(
        self,
        actor: Account,
        domain: str,
        search: str,
        state: str,
        page: int,
        size: int,
        filters: dict[str, str] | None = None,
    ) -> dict:
        actor.require("billing.read")
        async with self.db.sessions() as db:
            await db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            return await dao.directory(
                db, domain, search, state, page, size, datetime.now(UTC), filters
            )

    async def save(self, actor: Account, body: PlanDraft | RateDraft) -> dict:
        actor.require("billing.read")
        if isinstance(body, PlanDraft):
            domain, scope, expected, key = (
                "plan",
                body.sku,
                body.expected_draft_revision,
                body.terms.business_key,
            )
        else:
            domain, scope, expected, key = (
                "rate",
                body.terms.scope(),
                body.expected_revision,
                body.business_key,
            )
        actor.require(f"billing.{domain}s.manage")
        payload = body.model_dump(mode="json", by_alias=True)
        async with self.db.sessions.begin() as db:
            await lock_transaction(db, f"billing:pricing-key:{actor.user_id}:{key}")
            await lock_transaction(db, f"billing:pricing:{domain}:{scope}")
            previous = await dao.saved_by_key(db, actor.user_id, str(key))
            if previous:
                if previous.domain != domain or previous.payload != payload:
                    raise DomainError(409, "业务号已用于其他草稿")
                return dao.view(previous)
            last = await dao.latest(db, domain, scope)
            revision = last.revision if last else 0
            if isinstance(body, PlanDraft):
                published = await latest_version(db, scope)
                if body.terms.expected_revision != (published.revision if published else 0):
                    raise DomainError(409, "商品版本已变化，请刷新后核对")
            expected_head = 0 if domain == "plan" and last and last.effective_at else revision
            if expected_head != expected:
                raise DomainError(409, "已有更新的修订，请载入最新草稿")
            row = PricingVersion(
                id=str(uuid4()),
                domain=domain,
                scope=scope,
                revision=revision + 1,
                payload=payload,
                actor=actor.user_id,
                business_key=str(key),
                created_at=datetime.now(UTC),
            )
            db.add(row)
            return dao.view(row)

    async def publish(self, actor: Account, domain: str, identity: str, body: PublishDraft) -> dict:
        actor.require("billing.read")
        actor.require(f"billing.{domain}s.manage")
        async with self.db.sessions.begin() as db:
            row = await db.get(PricingVersion, identity)
            if not row or row.domain != domain:
                raise DomainError(404, "草稿不存在")
            await lock_transaction(db, f"billing:pricing:{domain}:{row.scope}")
            await db.refresh(row)
            command = body.model_dump(mode="json", by_alias=True)
            if row.revision != body.revision:
                raise DomainError(409, "草稿修订已变化")
            if row.effective_at:
                if row.publication != command:
                    raise DomainError(409, "该版本已经发布")
                return dao.view(row)
            if row.revision != await dao.head(db, domain, row.scope):
                raise DomainError(409, "此草稿已被更新，请使用最新修订")
            now = datetime.now(UTC)
            if domain == "plan":
                if body.effective_at is not None:
                    raise DomainError(422, "套餐生效时间请在草稿中设置")
                terms = PublishPlan.model_validate(row.payload["terms"]).model_copy(
                    update={"business_key": uuid4()}
                )
                release = await self.catalog.publish_in(db, actor, row.scope, terms)
                row.effective_at = release.effective_at
            else:
                if body.effective_at and body.effective_at <= now:
                    raise DomainError(422, "定时发布须选择未来时间")
                if await dao.future_exists(db, domain, row.scope, now):
                    raise DomainError(409, "同一条件已有待生效费率")
                row.effective_at = body.effective_at or now
            row.published_by = actor.user_id
            row.publication = command
            return dao.view(row)
