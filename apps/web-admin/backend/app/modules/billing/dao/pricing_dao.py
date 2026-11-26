"""定价版本的条件查询和按归属读取报价，写事务由用例持有。"""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.modules.billing.entity.do.pricing_do import PricingVersion, UsageQuote
from app.modules.billing.entity.vo.pricing import Selector


def scopes(item: Selector) -> list[str]:
    """精确配置修订、配置通用修订、能力通用模型，按此优先级匹配。"""
    return list(
        dict.fromkeys(
            [
                item.scope(),
                item.model_copy(update={"model_revision": 0}).scope(),
                item.model_copy(update={"model": "*", "model_revision": 0}).scope(),
            ]
        )
    )


def latest_effective(now: datetime, domain: str = "rate") -> Select:
    """按条件取当前发布版，未来版本和草稿不占用生效位。"""
    return select(
        PricingVersion.id,
        func.row_number()
        .over(
            partition_by=PricingVersion.scope,
            order_by=(PricingVersion.effective_at.desc(), PricingVersion.revision.desc()),
        )
        .label("position"),
    ).where(PricingVersion.domain == domain, PricingVersion.effective_at <= now)


async def matching(
    db: AsyncSession, items: Sequence[Selector], now: datetime
) -> dict[str, PricingVersion]:
    # 一次数据库快照为整笔报价选价，避免批量任务在并发调价时混用价格。
    keys = {key for item in items for key in scopes(item)}
    ranked = latest_effective(now).where(PricingVersion.scope.in_(keys)).subquery()
    rows = await db.scalars(
        select(PricingVersion)
        .join(ranked, ranked.c.id == PricingVersion.id)
        .where(ranked.c.position == 1)
    )
    return {row.scope: row for row in rows}


async def active(db: AsyncSession, item: Selector, now: datetime) -> PricingVersion | None:
    found = await matching(db, [item], now)
    return next((found[key] for key in scopes(item) if key in found), None)


async def head(db: AsyncSession, domain: str, scope: str) -> int:
    return int(
        await db.scalar(
            select(func.max(PricingVersion.revision)).where(
                PricingVersion.domain == domain, PricingVersion.scope == scope
            )
        )
        or 0
    )


async def directory(
    db: AsyncSession,
    domain: str,
    search: str,
    state: str,
    page: int,
    size: int,
    now: datetime,
    filters: dict[str, str] | None = None,
) -> dict:
    stmt = select(PricingVersion).where(PricingVersion.domain == domain)
    for field, value in (filters or {}).items():
        stmt = stmt.where(PricingVersion.payload["terms"][field].astext == value)
    if search:
        stmt = stmt.where(PricingVersion.scope.icontains(search, autoescape=True))
    if state == "draft":
        # 每组仅返回最新草稿；已发布或被替代的修订仍可在完整历史查阅。
        latest = (
            select(PricingVersion.scope, func.max(PricingVersion.revision).label("rev"))
            .where(PricingVersion.domain == domain)
            .group_by(PricingVersion.scope)
            .subquery()
        )
        stmt = stmt.join(
            latest,
            (PricingVersion.scope == latest.c.scope) & (PricingVersion.revision == latest.c.rev),
        ).where(PricingVersion.effective_at.is_(None))
    elif state == "scheduled":
        stmt = stmt.where(PricingVersion.effective_at > now)
    elif state == "effective":
        ranked = latest_effective(now, domain).subquery()
        stmt = stmt.join(ranked, ranked.c.id == PricingVersion.id).where(ranked.c.position == 1)
    rows = stmt.subquery()
    version = aliased(PricingVersion, rows)
    total = int(await db.scalar(select(func.count()).select_from(rows)) or 0)
    items = (
        await db.scalars(
            select(version)
            .order_by(version.created_at.desc(), version.scope, version.revision.desc())
            .offset((page - 1) * size)
            .limit(size)
        )
    ).all()
    return {"items": [view(row) for row in items], "total": total}


def view(v: PricingVersion) -> dict:
    return {
        "id": v.id,
        "scope": v.scope,
        "revision": v.revision,
        "payload": v.payload,
        "createdAt": v.created_at,
        "effectiveAt": v.effective_at,
        "publishedBy": v.published_by,
    }


async def owner_quote(db: AsyncSession, owner: str, identity: str) -> UsageQuote | None:
    return await db.scalar(
        select(UsageQuote).where(UsageQuote.id == identity, UsageQuote.owner == owner)
    )


async def saved_by_key(db: AsyncSession, actor: str, key: str) -> PricingVersion | None:
    return await db.scalar(
        select(PricingVersion).where(
            PricingVersion.actor == actor, PricingVersion.business_key == key
        )
    )


async def latest(db: AsyncSession, domain: str, scope: str) -> PricingVersion | None:
    return await db.scalar(
        select(PricingVersion)
        .where(PricingVersion.domain == domain, PricingVersion.scope == scope)
        .order_by(PricingVersion.revision.desc())
        .limit(1)
    )


async def future_exists(db: AsyncSession, domain: str, scope: str, now: datetime) -> bool:
    return bool(
        await db.scalar(
            select(PricingVersion.id)
            .where(
                PricingVersion.domain == domain,
                PricingVersion.scope == scope,
                PricingVersion.effective_at > now,
            )
            .limit(1)
        )
    )


async def quote_by_key(db: AsyncSession, owner: str, key: str) -> UsageQuote | None:
    return await db.scalar(
        select(UsageQuote).where(UsageQuote.owner == owner, UsageQuote.request_key == key)
    )
