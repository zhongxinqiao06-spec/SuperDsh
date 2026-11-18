"""按账号、作品归属与当前工程引用查询创作目录，分页前完成筛选。"""

from typing import Any

from sqlalchemy import and_, case, cast, column, func, literal, or_, select
from sqlalchemy.dialects.postgresql import JSONB, JSONPATH, array
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select

from app.modules.studio.entity.do.asset_do import StudioEntity
from app.modules.studio.entity.do.models import MediaJob, StudioAsset, StudioProject, StudioRevision


class DirectoryDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def page(self, query: Select, page: int, size: int) -> tuple[list[Any], int]:
        """计数与列表共用相同归属约束，不载入整库素材或任务。"""
        count = await self.session.scalar(
            select(func.count()).select_from(query.order_by(None).subquery())
        )
        rows = await self.session.execute(query.offset((page - 1) * size).limit(size))
        return list(rows), int(count or 0)

    def projects(self, owner: str, search: str, lifecycle: str = "active") -> Select:
        # 封面沿剪辑顺序选择同镜生成结果或本人已引用的媒体版本，两者不可串权。
        shots = (
            func.jsonb_array_elements(StudioRevision.document["shots"])
            .table_valued(column("value", JSONB), with_ordinality="position")
            .render_derived(name="shot")
        )
        cover_sources = (
            select(MediaJob.id)
            .select_from(shots)
            .outerjoin(
                MediaJob,
                and_(
                    MediaJob.id == shots.c.value["candidate"].astext,
                    MediaJob.project == StudioProject.id,
                    MediaJob.subject == shots.c.value["id"].astext,
                    MediaJob.kind == "video",
                    MediaJob.state == "ready",
                ),
            )
            .outerjoin(
                StudioAsset,
                and_(
                    StudioAsset.id == shots.c.value["videoAssetId"].astext,
                    StudioAsset.owner == owner,
                    or_(StudioAsset.project.is_(None), StudioAsset.project == StudioProject.id),
                    StudioRevision.document["assets"].op("?")(StudioAsset.id),
                    StudioAsset.definition["kind"].as_string() == "video",
                    StudioAsset.definition["fileId"].as_string().is_not(None),
                ),
            )
            .where(
                or_(MediaJob.id.is_not(None), StudioAsset.id.is_not(None)),
            )
            .order_by(shots.c.position)
            .limit(1)
            .correlate(StudioProject, StudioRevision)
        )
        cover = cover_sources.scalar_subquery()
        asset_cover = cover_sources.with_only_columns(StudioAsset.id).scalar_subquery()
        return (
            select(
                StudioProject.id,
                StudioProject.title,
                StudioProject.lifecycle,
                StudioProject.aspect_width.label("aspectWidth"),
                StudioProject.aspect_height.label("aspectHeight"),
                StudioProject.target_duration_ms.label("targetDurationMs"),
                StudioProject.revision,
                StudioProject.updated,
                cover.label("coverJobId"),
                asset_cover.label("coverAssetId"),
                func.jsonb_array_length(StudioRevision.document["shots"]).label("shots"),
                func.jsonb_array_length(
                    func.jsonb_path_query_array(
                        StudioRevision.document,
                        cast(
                            '$.shots[*] ? (@.candidate.type() == "string" || @.videoAssetId.type() == "string")',
                            JSONPATH,
                        ),
                    )
                ).label("adopted"),
            )
            .join(
                StudioRevision,
                and_(
                    StudioRevision.project == StudioProject.id,
                    StudioRevision.revision == StudioProject.revision,
                ),
            )
            .where(
                StudioProject.owner == owner,
                StudioProject.lifecycle == lifecycle,
                StudioProject.title.icontains(search, autoescape=True),
            )
            .order_by(StudioProject.updated.desc(), StudioProject.id)
        )

    def assets(self, owner: str, scope: str, kind: str, search: str, category: str = "") -> Select:
        asset = StudioAsset
        query: Select
        if scope == "personal":
            query = select(asset).where(asset.project.is_(None))
        else:
            # 作品既拥有派生版本，也能引用个人库的具体版本；同一版本可在多个作品使用。
            query = (
                select(asset, StudioProject.id, StudioProject.title)
                .select_from(StudioProject)
                .join(
                    StudioRevision,
                    and_(
                        StudioRevision.project == StudioProject.id,
                        StudioRevision.revision == StudioProject.revision,
                    ),
                )
                .join(
                    asset,
                    or_(
                        asset.project == StudioProject.id,
                        and_(
                            asset.project.is_(None),
                            StudioRevision.document["assets"].op("?")(asset.id),
                        ),
                    ),
                )
                .where(StudioProject.owner == owner)
            )
        categories = {
            "characters": ["character"],
            "environments": ["scene", "prop"],
            "media": ["image", "video", "audio", "music"],
        }
        if category in categories:
            query = query.where(asset.definition["kind"].as_string().in_(categories[category]))
        name = asset.definition["name"].as_string()
        query = query.where(asset.owner == owner)
        if search:
            matches = name.icontains(search, autoescape=True)
            if scope == "project":
                matches = or_(matches, StudioProject.title.icontains(search, autoescape=True))
            query = query.where(matches)
        if kind:
            query = query.where(asset.definition["kind"].as_string() == kind)
        return query.order_by(name, asset.id, *([StudioProject.id] if scope == "project" else []))

    async def derived_versions(self, owner: str, version: str) -> list[str]:
        """原始库版本的使用情况包含本片派生链，不把新个人库版本算成旧版本。"""
        versions = (
            select(StudioAsset.id)
            .where(StudioAsset.id == version, StudioAsset.owner == owner)
            .cte("derived", recursive=True)
        )
        versions = versions.union(
            select(StudioAsset.id)
            .join(versions, StudioAsset.parent == versions.c.id)
            .where(StudioAsset.owner == owner, StudioAsset.project.is_not(None))
        )
        return list(await self.session.scalars(select(versions.c.id)))

    def usage(
        self, owner: str, asset: StudioAsset, project: str | None, versions: list[str]
    ) -> Select:
        # 分页查询关联作品的当前镜序，只有打开素材详情才需要这些字段。
        document = StudioRevision.document
        query = (
            select(
                StudioProject.id,
                StudioProject.title,
                document["shots"],
                document["music"].as_string(),
                document["scenes"],
                document["soundEffects"],
            )
            .join(
                StudioRevision,
                and_(
                    StudioRevision.project == StudioProject.id,
                    StudioRevision.revision == StudioProject.revision,
                ),
            )
            .where(StudioProject.owner == owner, document["assets"].op("?|")(array(versions)))
            .order_by(StudioProject.updated.desc(), StudioProject.id)
        )
        if project or asset.project:
            query = query.where(StudioProject.id == (project or asset.project))
        return query

    def jobs(
        self, owner: str, state: str, kind: str, search: str, personal: bool = False
    ) -> Select:
        # 汇总只选择展示字段，避免导出工程快照、供应商回执及凭据进入列表数据。
        query = (
            select(
                MediaJob.id,
                MediaJob.kind,
                MediaJob.state,
                MediaJob.revision,
                MediaJob.updated,
                MediaJob.error,
                MediaJob.subject,
                MediaJob.payload["recoveryState"].as_string().label("recoveryState"),
                MediaJob.provider_id.is_not(None).label("hasReceipt"),
                func.left(
                    case(
                        (MediaJob.kind == "video", MediaJob.payload["prompt"].as_string()),
                        (MediaJob.kind == "speech", MediaJob.payload["text"].as_string()),
                        else_="",
                    ),
                    90,
                ).label("summary"),
                StudioProject.id.label("project"),
                func.coalesce(StudioProject.title, StudioEntity.name).label("projectTitle"),
                MediaJob.library_entity.label("entity"),
                StudioEntity.kind.label("entityKind"),
            )
            .outerjoin(StudioProject, StudioProject.id == MediaJob.project)
            .outerjoin(StudioEntity, StudioEntity.id == MediaJob.library_entity)
            .where(
                or_(
                    StudioProject.owner == owner,
                    and_(
                        literal(personal),
                        MediaJob.project.is_(None),
                        MediaJob.owner == owner,
                        StudioEntity.owner_id == owner,
                    ),
                )
            )
        )
        if search:
            query = query.where(
                func.coalesce(StudioProject.title, StudioEntity.name).icontains(
                    search, autoescape=True
                )
            )
        if state:
            query = query.where(MediaJob.state == state)
        if kind:
            query = query.where(MediaJob.kind == kind)
        return query.order_by(MediaJob.updated.desc(), MediaJob.id)
