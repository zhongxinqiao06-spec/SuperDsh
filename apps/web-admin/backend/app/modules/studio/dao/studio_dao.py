"""作品聚合的所有查询必须包含账号或先取得受保护的项目。"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.studio.entity.do.models import MediaJob, StudioAsset, StudioProject, StudioRevision


class StudioDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def summaries(self, owner: str) -> list[tuple[StudioProject, dict]]:
        query = (
            select(StudioProject, StudioRevision.document)
            .join(
                StudioRevision,
                (StudioRevision.project == StudioProject.id)
                & (StudioRevision.revision == StudioProject.revision),
            )
            .where(StudioProject.owner == owner)
            .order_by(StudioProject.updated.desc())
        )
        return list((await self.session.execute(query)).tuples())

    async def by_conversation(self, owner: str, conversation: str) -> str | None:
        """DSH 上下文只能定位本人的作品，禁止客户端提供任意作品替代。"""
        return await self.session.scalar(
            select(StudioProject.id).where(
                StudioProject.owner == owner, StudioProject.session_id == conversation
            )
        )

    async def project(self, owner: str, identifier: str, *, lock: bool = False) -> StudioProject:
        query = select(StudioProject).where(
            StudioProject.id == identifier, StudioProject.owner == owner
        )
        record = await self.session.scalar(query.with_for_update() if lock else query)
        if record is None:
            raise DomainError(404, "作品不存在")
        return record

    async def snapshot(self, project: StudioProject, version: int | None = None) -> StudioRevision:
        result = await self.session.get(StudioRevision, (project.id, version or project.revision))
        if result is None:
            raise DomainError(404, "工程版本不存在")
        return result

    async def owned_asset(self, owner: str, identifier: str) -> StudioAsset:
        asset = await self.session.scalar(
            select(StudioAsset).where(StudioAsset.owner == owner, StudioAsset.id == identifier)
        )
        if asset is None:
            raise DomainError(404, "素材版本不存在")
        return asset

    async def assets(self, owner: str, project: str | None) -> list[StudioAsset]:
        query = select(StudioAsset).where(
            StudioAsset.owner == owner,
            (StudioAsset.project.is_(None)) | (StudioAsset.project == project),
        )
        return list(await self.session.scalars(query))

    async def jobs(self, project: StudioProject) -> list[MediaJob]:
        query = (
            select(MediaJob).where(MediaJob.project == project.id).order_by(MediaJob.updated.desc())
        )
        return list(await self.session.scalars(query))

    async def locked_job(self, project: StudioProject, identifier: str) -> MediaJob:
        """仅持有对应作品权限后按行锁读取回执，避免两个页面同时恢复同一任务。"""
        record = await self.session.scalar(
            select(MediaJob)
            .where(MediaJob.id == identifier, MediaJob.project == project.id)
            .with_for_update()
        )
        if record is None:
            raise DomainError(404, "制作任务不存在")
        return record

    async def history(self, project: StudioProject) -> list[dict[str, object]]:
        query = (
            select(StudioRevision.revision, StudioRevision.label)
            .where(StudioRevision.project == project.id)
            .order_by(StudioRevision.revision.desc())
        )
        return [
            {"revision": rev, "label": label} for rev, label in await self.session.execute(query)
        ]

    def append(self, project: StudioProject, document: dict, label: str) -> None:
        project.revision += 1
        self.session.add(
            StudioRevision(
                project=project.id, revision=project.revision, document=document, label=label
            )
        )
