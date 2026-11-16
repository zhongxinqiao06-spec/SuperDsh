"""设定与媒体版本查询；权限判断与事务由服务层负责。"""

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.studio.entity.do.asset_do import (
    AssetFamily,
    AssetVersion,
    EntityVersion,
    EntityVersionAsset,
    StudioEntity,
)
from app.modules.studio.entity.do.models import StudioAsset


class AssetDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def lock_family(self, identifier: str) -> None:
        """尚不存在的家族同样串行创建，避免跨作品引用竞争产生重复身份。"""
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
            {"key": "studio-asset:" + identifier},
        )

    async def entity_version(self, identifier: str) -> EntityVersion | None:
        return await self.session.get(EntityVersion, identifier)

    async def version(self, identifier: str) -> StudioAsset | None:
        return await self.session.get(StudioAsset, identifier)

    async def entity(self, identifier: str, *, lock: bool = False) -> StudioEntity | None:
        query = select(StudioEntity).where(StudioEntity.id == identifier)
        return await self.session.scalar(query.with_for_update() if lock else query)

    async def references(self, identifier: str) -> list[EntityVersionAsset]:
        return list(
            await self.session.scalars(
                select(EntityVersionAsset)
                .where(EntityVersionAsset.entity_version_id == identifier)
                .order_by(EntityVersionAsset.position)
            )
        )

    async def next_entity_version(self, family: str) -> int:
        return (
            int(
                await self.session.scalar(
                    select(func.max(EntityVersion.version_no)).where(
                        EntityVersion.entity_id == family
                    )
                )
                or 0
            )
            + 1
        )

    async def next_media_version(self, family: str) -> int:
        return (
            int(
                await self.session.scalar(
                    select(func.max(AssetVersion.version_no)).where(
                        AssetVersion.family_id == family
                    )
                )
                or 0
            )
            + 1
        )

    async def media_family(self, identifier: str) -> AssetFamily | None:
        return await self.session.scalar(
            select(AssetFamily).where(AssetFamily.id == identifier).with_for_update()
        )

    def add(
        self, record: StudioEntity | EntityVersion | EntityVersionAsset | AssetFamily | AssetVersion
    ) -> None:
        self.session.add(record)
