"""资源 DAO 仅负责记录映射、锁和读写，不做资源授权。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.modules.resources.entity.bo.resources import Binding, Resource
from app.modules.resources.entity.do.models import (
    BindingRow,
    InitializationRow,
    ResourceRow,
    ResourceVersionRow,
)
from app.modules.resources.service.ports import ResourceTransaction


class SqlResourceTransaction:
    """由服务持有的一次短事务；持久化当前记录和历史版本。"""

    def __init__(self, session: AsyncSession) -> None:
        self.db = session

    async def lock(self, key: str) -> None:
        await lock_transaction(self.db, "web-admin:resource:" + key)

    async def get(self, resource_id: str) -> Resource | None:
        row = await self.db.get(ResourceRow, resource_id)
        return (
            Resource(**{name: getattr(row, name) for name in Resource.__dataclass_fields__})
            if row
            else None
        )

    async def all(self, kind: str, owner: str) -> list[Resource]:
        rows = await self.db.scalars(
            select(ResourceRow)
            .where(
                ResourceRow.kind == kind,
                ResourceRow.owner_id == owner,
                ResourceRow.deleted.is_(False),
            )
            .order_by(ResourceRow.updated_at.desc(), ResourceRow.id)
        )
        return [
            Resource(**{name: getattr(row, name) for name in Resource.__dataclass_fields__})
            for row in rows
        ]

    async def save(self, resource: Resource, snapshot: dict[str, object]) -> None:
        await self.db.merge(ResourceRow(**asdict(resource)))
        await self.db.flush()
        self.db.add(
            ResourceVersionRow(
                resource_id=resource.id,
                version=resource.version,
                snapshot=snapshot,
                secret_ciphertext=resource.secret_ciphertext,
            )
        )

    async def published_agents(self) -> list[Resource]:
        """只查询启用且发布的定义，是否允许浏览由 service 决定。"""
        rows = await self.db.scalars(
            select(ResourceRow)
            .where(
                ResourceRow.kind == "agent",
                ResourceRow.published.is_(True),
                ResourceRow.enabled.is_(True),
                ResourceRow.deleted.is_(False),
            )
            .order_by(ResourceRow.updated_at.desc(), ResourceRow.id)
        )
        return [
            Resource(**{name: getattr(row, name) for name in Resource.__dataclass_fields__})
            for row in rows
        ]

    async def versions(self, resource_id: str) -> list[dict[str, object]]:
        rows = await self.db.scalars(
            select(ResourceVersionRow)
            .where(ResourceVersionRow.resource_id == resource_id)
            .order_by(ResourceVersionRow.version.desc())
        )
        return [row.snapshot for row in rows]

    async def save_binding(self, binding: Binding) -> None:
        self.db.add(BindingRow(**asdict(binding)))

    async def snapshot(self, resource_id: str, version: int) -> dict[str, object] | None:
        row = await self.db.get(ResourceVersionRow, (resource_id, version))
        return dict(row.snapshot) if row else None

    async def secret(self, resource_id: str, version: int) -> str | None:
        row = await self.db.get(ResourceVersionRow, (resource_id, version))
        return row.secret_ciphertext if row else None

    async def binding(self, binding_id: str) -> Binding | None:
        row = await self.db.get(BindingRow, binding_id)
        return (
            Binding(row.id, row.owner_id, row.session_id, row.version, row.snapshots)
            if row
            else None
        )

    async def initialized(self, owner: str, package: str) -> bool:
        return await self.db.get(InitializationRow, (owner, package)) is not None

    async def mark_initialized(self, owner: str, package: str) -> None:
        self.db.add(InitializationRow(owner_id=owner, package_id=package))


class SqlResourceRepository:
    """资源服务的数据访问工厂，连接池由应用统一关闭。"""

    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[ResourceTransaction]:
        async with self.database.sessions.begin() as session:
            yield SqlResourceTransaction(session)
