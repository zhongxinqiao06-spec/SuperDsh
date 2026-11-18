"""素材目录按身份聚合；来源、版本和幂等记录集中查询，不在页面逐条请求。"""

from sqlalchemy import Integer, String, and_, case, cast, func, literal, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql import Select

from app.modules.studio.dao.directory_dao import DirectoryDao
from app.modules.studio.entity.do.asset_do import (
    AssetFamily,
    AssetVersion,
    EntityVariant,
    EntityVersion,
    EntityVersionAsset,
    StudioEntity,
)
from app.modules.studio.entity.do.library_do import LibraryBinding, LibraryOperation
from app.modules.studio.entity.do.models import MediaJob, StudioAsset, StudioProject, StudioRevision


class LibraryDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def directory(
        self, owner: str, scope: str, kind: str, search: str, category: str, archived: bool = False
    ) -> Select:
        query = DirectoryDao(self.session).assets(owner, scope, kind, search, category)
        if category in {"scenes", "props"}:
            query = query.where(
                StudioAsset.definition["kind"].as_string()
                == {
                    "scenes": "scene",
                    "props": "prop",
                }[category]
            )
        current = union_all(
            select(StudioEntity.current_version_id.label("version")).where(
                StudioEntity.owner_id == owner,
                StudioEntity.archived_at.is_not(None)
                if archived
                else StudioEntity.archived_at.is_(None),
            ),
            select(AssetFamily.current_version_id.label("version")).where(
                AssetFamily.owner_id == owner,
                AssetFamily.archived_at.is_not(None)
                if archived
                else AssetFamily.archived_at.is_(None),
            ),
        ).subquery()
        if scope == "personal":
            return query.where(StudioAsset.id.in_(select(current.c.version)))
        # 优先本片当前引用版本；尚未加入工程的新设定仍可在“作品中的素材”找到。
        ranked = (
            query.with_only_columns(
                StudioAsset.id.label("asset"),
                StudioProject.id.label("work"),
                func.row_number()
                .over(
                    partition_by=(StudioProject.id, StudioAsset.family),
                    order_by=(
                        case(
                            (StudioRevision.document["assets"].op("?")(StudioAsset.id), 0), else_=1
                        ),
                        cast(StudioAsset.definition["version"].as_string(), Integer).desc(),
                        StudioAsset.id,
                    ),
                )
                .label("rank"),
            )
            .order_by(None)
            .subquery()
        )
        return (
            select(StudioAsset, StudioProject.id, StudioProject.title)
            .join(ranked, and_(ranked.c.asset == StudioAsset.id, ranked.c.rank == 1))
            .join(StudioProject, StudioProject.id == ranked.c.work)
            .order_by(
                StudioAsset.definition["name"].as_string(), StudioProject.id, StudioAsset.family
            )
        )

    async def versions(self, owner: str, family: str) -> list[StudioAsset]:
        return list(
            await self.session.scalars(
                select(StudioAsset)
                .where(
                    StudioAsset.owner == owner,
                    StudioAsset.family == family,
                )
                .order_by(cast(StudioAsset.definition["version"].as_string(), Integer).desc())
            )
        )

    async def versions_by_id(self, owner: str, identifiers: list[str]) -> dict[str, StudioAsset]:
        return {
            asset.id: asset
            for asset in await self.session.scalars(
                select(StudioAsset).where(
                    StudioAsset.owner == owner,
                    StudioAsset.id.in_(identifiers),
                )
            )
        }

    async def current(self, owner: str, family: str) -> StudioAsset | None:
        return await self.session.scalar(
            select(StudioAsset).where(
                StudioAsset.owner == owner,
                StudioAsset.family == family,
                or_(
                    StudioAsset.id.in_(
                        select(StudioEntity.current_version_id).where(
                            StudioEntity.id == family, StudioEntity.archived_at.is_(None)
                        )
                    ),
                    StudioAsset.id.in_(
                        select(AssetFamily.current_version_id).where(
                            AssetFamily.id == family, AssetFamily.archived_at.is_(None)
                        )
                    ),
                ),
            )
        )

    async def variants(self, family: str) -> list[EntityVariant]:
        return list(
            await self.session.scalars(
                select(EntityVariant)
                .where(
                    EntityVariant.entity_id == family,
                )
                .order_by(EntityVariant.name, EntityVariant.id)
            )
        )

    async def metadata(self, owner: str, assets: list[StudioAsset]) -> dict[str, dict]:
        if not assets:
            return {}
        version_ids = [asset.id for asset in assets]
        variants = {
            row[0]: {"variantId": row[1], "variantName": row[2]}
            for row in await self.session.execute(
                select(
                    EntityVersion.id,
                    EntityVariant.id,
                    EntityVariant.name,
                )
                .join(EntityVariant, EntityVariant.id == EntityVersion.variant_id)
                .where(EntityVersion.id.in_(version_ids))
            )
        }
        previews = dict(
            (
                await self.session.execute(
                    select(
                        EntityVersionAsset.entity_version_id,
                        EntityVersionAsset.asset_version_id,
                    ).where(
                        EntityVersionAsset.entity_version_id.in_(version_ids),
                        EntityVersionAsset.purpose == "voice-preview",
                    )
                )
            ).all()
        )
        media = {
            row[0]: {"durationMs": row[1], "width": row[2], "height": row[3]}
            for row in await self.session.execute(
                select(
                    AssetVersion.id,
                    func.coalesce(
                        AssetVersion.duration_ms,
                        case(
                            (
                                MediaJob.state == "ready",
                                cast(MediaJob.payload["duration"].as_string(), Integer),
                            ),
                            else_=None,
                        ),
                    ),
                    AssetVersion.width,
                    AssetVersion.height,
                )
                .outerjoin(MediaJob, MediaJob.id == AssetVersion.source_job_id)
                .where(AssetVersion.id.in_(version_ids))
            )
        }
        # 来源绑定只暴露当前账号私有库的摘要，不把另一作品任务或私有路径带到页面。
        roots = union_all(
            select(
                StudioEntity.id.label("family"),
                StudioEntity.current_version_id.label("current"),
                StudioEntity.name.label("name"),
            ).where(
                StudioEntity.owner_id == owner,
                StudioEntity.project_id.is_(None),
                StudioEntity.archived_at.is_(None),
            ),
            select(
                AssetFamily.id.label("family"),
                AssetFamily.current_version_id.label("current"),
                AssetFamily.name.label("name"),
            ).where(
                AssetFamily.owner_id == owner,
                AssetFamily.project_id.is_(None),
                AssetFamily.archived_at.is_(None),
            ),
        ).subquery()
        bindings = {
            (row[0], row[1], row[7]): {
                "family": row[2],
                "versionId": row[3] or row[4],
                "currentVersionId": row[5],
                "name": row[6],
                "fieldVersions": row[8],
            }
            for row in await self.session.execute(
                select(
                    LibraryBinding.project_id,
                    LibraryBinding.project_family_id,
                    LibraryBinding.library_family_id,
                    LibraryBinding.imported_version_id,
                    LibraryBinding.published_version_id,
                    func.coalesce(EntityVariant.current_version_id, roots.c.current),
                    roots.c.name,
                    LibraryBinding.project_variant_id,
                    LibraryBinding.field_versions,
                )
                .join(roots, roots.c.family == LibraryBinding.library_family_id)
                .outerjoin(
                    EntityVersion,
                    EntityVersion.id
                    == func.coalesce(
                        LibraryBinding.imported_version_id, LibraryBinding.published_version_id
                    ),
                )
                .outerjoin(EntityVariant, EntityVariant.id == EntityVersion.variant_id)
                .where(
                    LibraryBinding.owner_id == owner,
                    LibraryBinding.project_family_id.in_([asset.family for asset in assets]),
                )
            )
        }
        result = {
            asset.id: {
                "variantId": None,
                "variantName": None,
                **variants.get(asset.id, {}),
                "origin": bindings.get(
                    (asset.project, asset.family, variants.get(asset.id, {}).get("variantId", ""))
                ),
                "voicePreviewAssetId": previews.get(asset.id),
                "durationMs": None,
                "width": None,
                "height": None,
                **media.get(asset.id, {}),
            }
            for asset in assets
        }
        missing = [
            asset.id
            for asset in assets
            if asset.project and asset.parent and not result[asset.id]["origin"]
        ]
        if missing:
            # 旧工程尚无显式绑定时批量追溯真实来源；读取不补写数据，也不为每张卡发一次查询。
            ancestor = aliased(StudioAsset)
            chain = (
                select(
                    StudioAsset.id.label("target"),
                    StudioAsset.id.label("ancestor"),
                    StudioAsset.parent.label("parent"),
                    StudioAsset.project.label("project"),
                    literal(0).label("depth"),
                )
                .where(StudioAsset.owner == owner, StudioAsset.id.in_(missing))
                .cte("library_ancestors", recursive=True)
            )
            chain = chain.union_all(
                select(
                    cast(chain.c.target, String),
                    ancestor.id,
                    ancestor.parent,
                    ancestor.project,
                    chain.c.depth + 1,
                )
                .join(ancestor, ancestor.id == chain.c.parent)
                .where(
                    ancestor.owner == owner,
                    chain.c.project.is_not(None),
                    chain.c.depth < 256,
                )
            )
            origins = await self.session.execute(
                select(
                    cast(chain.c.target, String),
                    ancestor.id,
                    ancestor.family,
                    func.coalesce(EntityVariant.current_version_id, roots.c.current),
                    roots.c.name,
                )
                .select_from(chain)
                .join(ancestor, ancestor.id == chain.c.ancestor)
                .join(roots, roots.c.family == ancestor.family)
                .outerjoin(EntityVersion, EntityVersion.id == ancestor.id)
                .outerjoin(EntityVariant, EntityVariant.id == EntityVersion.variant_id)
                .where(chain.c.project.is_(None))
            )
            for target, version, family, current, name in origins:
                if not isinstance(target, str):
                    raise TypeError("素材来源查询返回了无效标识")
                result[target]["origin"] = {
                    "family": family,
                    "versionId": version,
                    "currentVersionId": current,
                    "name": name,
                }
        return result

    async def personal_ancestor(self, owner: str, asset: StudioAsset) -> StudioAsset | None:
        """兼容旧导入记录，仅沿真实来源链寻找库身份，绝不按名称匹配。"""
        seen: set[str] = set()
        parent = asset.parent
        while parent and parent not in seen:
            seen.add(parent)
            row = await self.session.scalar(
                select(StudioAsset).where(
                    StudioAsset.owner == owner,
                    StudioAsset.id == parent,
                )
            )
            if row is None:
                return None
            if row.project is None:
                return row
            parent = row.parent
        return None

    async def binding(
        self, owner: str, project: str, family: str, variant: str = ""
    ) -> LibraryBinding | None:
        return await self.session.scalar(
            select(LibraryBinding).where(
                LibraryBinding.owner_id == owner,
                LibraryBinding.project_id == project,
                LibraryBinding.project_family_id == family,
                LibraryBinding.project_variant_id == variant,
            )
        )

    async def root(self, owner: str, family: str) -> StudioEntity | AssetFamily | None:
        entity = await self.session.scalar(
            select(StudioEntity)
            .where(
                StudioEntity.id == family,
                StudioEntity.owner_id == owner,
            )
            .with_for_update()
        )
        if entity is not None:
            return entity
        return await self.session.scalar(
            select(AssetFamily)
            .where(
                AssetFamily.id == family,
                AssetFamily.owner_id == owner,
            )
            .with_for_update()
        )

    async def operation(self, owner: str, key: str) -> LibraryOperation | None:
        return await self.session.scalar(
            select(LibraryOperation).where(
                LibraryOperation.owner_id == owner,
                LibraryOperation.request_key == key,
            )
        )

    def add(self, row: LibraryBinding | LibraryOperation) -> None:
        self.session.add(row)
