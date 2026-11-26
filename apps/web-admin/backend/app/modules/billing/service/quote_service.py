"""逐项匹配服务端费率并冻结报价。任务确认与报价锁定使用调用方的同一事务。"""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.billing.dao import pricing_dao as dao
from app.modules.billing.entity.do.pricing_do import UsageQuote
from app.modules.billing.entity.vo.pricing import QuoteRequest, RateTerms, Trial, UsageItem
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.billing_directory import owner_has_unlimited_credit


def price(item: UsageItem, rate: RateTerms) -> dict:
    """每个子项分别向上取整，包括每百字配音。"""
    units = (item.quantity + rate.unit_size - 1) // rate.unit_size
    return {
        **item.model_dump(mode="json", by_alias=True),
        "unit": rate.unit,
        "unitSize": rate.unit_size,
        "unitPoints": rate.unit_points,
        "units": units,
        "points": units * rate.unit_points,
    }


def quote_view(row: UsageQuote) -> dict:
    return {
        "id": row.id,
        "source": row.source,
        "items": row.snapshot["items"],
        "unlimited": row.snapshot.get("unlimited", False),
        "totalPoints": row.snapshot["totalPoints"],
        "expiresAt": row.expires_at.isoformat(),
        "lockedAt": row.locked_at.isoformat() if row.locked_at else None,
    }


async def quote_in(
    db: AsyncSession, owner: str, key: str, source: str, items: list[UsageItem]
) -> dict:
    await lock_transaction(db, f"billing:quote:{owner}:{key}")
    raw = [i.model_dump(mode="json", by_alias=True) for i in items]
    previous = await dao.quote_by_key(db, owner, key)
    if previous:
        if previous.source != source or previous.snapshot["input"] != raw:
            raise DomainError(409, "相同业务号的报价参数已变化")
        return quote_view(previous)
    now = datetime.now(UTC)
    lines = []
    matching = await dao.matching(db, items, now)
    for item in items:
        row = next((matching[key] for key in dao.scopes(item) if key in matching), None)
        if row is None:
            raise DomainError(
                422, f"尚未配置适用费率：{item.capability} / {item.spec} / {item.payer}"
            )
        lines.append(
            {
                **price(item, RateTerms.model_validate(row.payload["terms"])),
                "rateId": row.id,
                "rateRevision": row.revision,
            }
        )
    result = UsageQuote(
        id=str(uuid4()),
        owner=owner,
        request_key=key,
        source=source,
        expires_at=now + timedelta(minutes=15),
        snapshot={
            "unlimited": await owner_has_unlimited_credit(db, owner),
            "input": raw,
            "items": lines,
            "totalPoints": sum(line["points"] for line in lines),
        },
    )
    db.add(result)
    return quote_view(result)


async def lock_plan_quote(db: AsyncSession, owner: str, plan: str, identity: str) -> dict:
    row = await dao.owner_quote(db, owner, identity)
    if row is None or row.request_key != "plan:" + plan:
        raise DomainError(409, "原任务报价不存在，请重新预检")
    now = datetime.now(UTC)
    if not row.locked_at:
        if bool(row.snapshot.get("unlimited")) != await owner_has_unlimited_credit(db, owner):
            raise DomainError(409, "账号的额度权益已变化，请重新预检")
        if row.expires_at <= now:
            raise DomainError(409, "报价已过期，请重新预检")
        row.locked_at = now
    return quote_view(row)


class QuoteService:
    def __init__(self, database: Database) -> None:
        self.db = database

    async def trial(self, actor: Account, body: Trial) -> dict:
        actor.require("billing.read")
        async with self.db.sessions() as db:
            active = await dao.active(db, body.item, datetime.now(UTC))
            current = (
                price(body.item, RateTerms.model_validate(active.payload["terms"]))
                if active
                else None
            )
            if body.candidate and body.candidate.scope() not in dao.scopes(body.item):
                raise DomainError(422, "草稿费率与试算条件不匹配")
            candidate = price(body.item, body.candidate) if body.candidate else current
            return {
                "current": current,
                "candidate": candidate,
                "difference": candidate["points"] - current["points"]
                if current and candidate
                else None,
            }

    async def quote(self, actor: Account, body: QuoteRequest) -> dict:
        actor.require("models.use")
        for product in {item.product for item in body.items}:
            actor.require("products." + product)
        async with self.db.sessions.begin() as db:
            return await quote_in(
                db, actor.user_id, "preview:" + str(body.business_key), body.source, body.items
            )

    async def lookup(self, actor: Account, identity: str) -> dict:
        actor.require("models.use")
        async with self.db.sessions() as db:
            row = await dao.owner_quote(db, actor.user_id, identity)
            if not row:
                raise DomainError(404, "报价不存在")
            for item in row.snapshot["items"]:
                actor.require("products." + item["product"])
            return quote_view(row)
