"""设定与媒体版本查询；权限判断与事务由服务层负责。"""

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.studio.entity.do.asset_do import (
    AssetFamily,
    AssetVersion,
    EntityVariant,
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

    async def media_version(self, identifier: str) -> AssetVersion | None:
        return await self.session.get(AssetVersion, identifier)

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

    async def variant(self, identifier: str) -> EntityVariant | None:
        return await self.session.get(EntityVariant, identifier)

    async def save_media_metadata(
        self, identifier: str, duration_ms: int, width: int | None = None, height: int | None = None
    ) -> None:
        """仅保存已读取文件的客观属性，不修改文件、来源或业务版本。"""
        record = await self.session.get(AssetVersion, identifier)
        if record is not None:
            record.duration_ms = duration_ms
            if width is not None:
                record.width = width
            if height is not None:
                record.height = height

    async def media_metadata(self, identifiers: list[str]) -> dict[str, int]:
        return {
            row[0]: int(row[1])
            for row in await self.session.execute(
                select(AssetVersion.id, AssetVersion.duration_ms).where(
                    AssetVersion.id.in_(identifiers), AssetVersion.duration_ms.is_not(None)
                )
            )
            if row[1] is not None
        }

    async def replace_references(
        self, target: str, purpose: str, sources: list[EntityVersionAsset]
    ) -> None:
        await self.session.execute(
            delete(EntityVersionAsset).where(
                EntityVersionAsset.entity_version_id == target,
                EntityVersionAsset.purpose == purpose,
            )
        )
        for source in sources:
            if source.purpose == purpose:
                self.session.add(
                    EntityVersionAsset(
                        entity_version_id=target,
                        asset_version_id=source.asset_version_id,
                        purpose=purpose,
                        position=source.position,
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
        self,
        record: StudioEntity
        | EntityVersion
        | EntityVariant
        | EntityVersionAsset
        | AssetFamily
        | AssetVersion,
    ) -> None:
        self.session.add(record)
