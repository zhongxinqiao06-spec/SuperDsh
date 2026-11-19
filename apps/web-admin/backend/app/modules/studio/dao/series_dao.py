"""整剧和分集仓储；查询始终绑定账号，写入锁由用例显式要求。"""

from sqlalchemy import case, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.studio.entity.do.models import MediaJob
from app.modules.studio.entity.do.series_do import (
    SeriesCommand,
    SeriesProposal,
    SeriesSettingVersion,
    SeriesStructurePlan,
    StudioEpisode,
    StudioSeries,
)


class SeriesDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def creation(self, owner: str, key: str) -> StudioSeries | None:
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
            {"key": "studio-series:" + owner + ":" + key},
        )
        return await self.session.scalar(
            select(StudioSeries).where(
                StudioSeries.owner == owner, StudioSeries.creation_key == key
            )
        )

    async def series(self, owner: str, identity: str, *, lock: bool = False) -> StudioSeries:
        query = select(StudioSeries).where(StudioSeries.owner == owner, StudioSeries.id == identity)
        row = await self.session.scalar(query.with_for_update() if lock else query)
        if row is None:
            raise DomainError(404, "整剧不存在")
        return row

    async def episodes(
        self, owner: str, identity: str, *, archived: bool = False
    ) -> list[StudioEpisode]:
        return list(
            await self.session.scalars(
                select(StudioEpisode)
                .where(
                    StudioEpisode.owner == owner,
                    StudioEpisode.series_id == identity,
                    StudioEpisode.archived == archived,
                )
                .order_by(StudioEpisode.position)
            )
        )

    async def episode(self, owner: str, series: str, identity: str) -> StudioEpisode:
        row = await self.session.scalar(
            select(StudioEpisode).where(
                StudioEpisode.owner == owner,
                StudioEpisode.series_id == series,
                StudioEpisode.id == identity,
                StudioEpisode.archived.is_(False),
            )
        )
        if row is None:
            raise DomainError(404, "分集不存在")
        return row

    async def context(self, owner: str, project: str) -> StudioEpisode | None:
        return await self.session.scalar(
            select(StudioEpisode).where(
                StudioEpisode.owner == owner, StudioEpisode.project_id == project
            )
        )

    async def settings(self, series: str, revision: int) -> SeriesSettingVersion:
        row = await self.session.get(SeriesSettingVersion, (series, revision))
        if row is None:
            raise DomainError(409, "全剧设定版本缺失")
        return row

    async def command(self, series: str, key: str) -> SeriesCommand | None:
        return await self.session.scalar(
            select(SeriesCommand).where(
                SeriesCommand.series_id == series, SeriesCommand.operation_key == key
            )
        )

    async def latest_exports(self, projects: list[str]) -> dict[str, MediaJob]:
        latest = (
            select(
                MediaJob.id,
                func.row_number()
                .over(
                    partition_by=MediaJob.project, order_by=(MediaJob.updated.desc(), MediaJob.id)
                )
                .label("position"),
            )
            .where(
                MediaJob.project.in_(projects), MediaJob.kind == "export", MediaJob.state == "ready"
            )
            .subquery()
        )
        query = (
            select(MediaJob).join(latest, latest.c.id == MediaJob.id).where(latest.c.position == 1)
        )
        return {str(row.project): row for row in await self.session.scalars(query)}

    async def proposal(self, series: str, identity: str) -> SeriesProposal:
        row = await self.session.scalar(
            select(SeriesProposal)
            .where(SeriesProposal.series_id == series, SeriesProposal.id == identity)
            .execution_options(populate_existing=True)
        )
        if row is None:
            raise DomainError(404, "编排建议不存在")
        return row

    async def proposal_for_project(self, owner: str, project: str, identity: str) -> SeriesProposal:
        row = await self.session.scalar(
            select(SeriesProposal)
            .join(StudioSeries, StudioSeries.id == SeriesProposal.series_id)
            .where(
                StudioSeries.owner == owner,
                SeriesProposal.project_id == project,
                SeriesProposal.id == identity,
            )
        )
        if row is None:
            raise DomainError(404, "本会话未授权该编排建议")
        return row

    async def proposals(self, series: str) -> list[SeriesProposal]:
        return list(
            await self.session.scalars(
                select(SeriesProposal)
                .where(SeriesProposal.series_id == series)
                .order_by(
                    case((SeriesProposal.state.in_(["waiting", "ready"]), 0), else_=1),
                    SeriesProposal.created_at.desc(),
                )
                .limit(150)
            )
        )

    async def structure_plan(self, series: str, identity: str) -> SeriesStructurePlan:
        row = await self.session.scalar(
            select(SeriesStructurePlan).where(
                SeriesStructurePlan.series_id == series, SeriesStructurePlan.id == identity
            )
        )
        if row is None:
            raise DomainError(404, "分集结构方案不存在")
        return row

    async def archive_position(self, series: str) -> int:
        return 1000 + int(
            await self.session.scalar(
                select(func.max(StudioEpisode.position)).where(StudioEpisode.series_id == series)
            )
            or 0
        )

    def add(
        self,
        row: StudioSeries
        | StudioEpisode
        | SeriesCommand
        | SeriesSettingVersion
        | SeriesProposal
        | SeriesStructurePlan,
    ) -> None:
        self.session.add(row)
