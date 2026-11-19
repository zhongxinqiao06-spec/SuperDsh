"""三类作品共享目录；先按归属和分类分页，再加载当前页摘要。"""

from typing import Any

from sqlalchemy import exists, func, literal, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.studio.dao.directory_dao import DirectoryDao
from app.modules.studio.entity.do.models import StudioProject
from app.modules.studio.entity.do.series_do import StudioEpisode, StudioSeries


class WorkDirectoryDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def page(
        self, owner: str, mode: str, lifecycle: str, search: str, page: int, size: int
    ) -> tuple[list[dict], int]:
        projects = select(
            StudioProject.id,
            StudioProject.title,
            StudioProject.revision,
            StudioProject.updated,
            StudioProject.lifecycle,
            StudioProject.creation_mode.label("kind"),
        ).where(
            StudioProject.owner == owner,
            StudioProject.lifecycle == lifecycle,
            StudioProject.title.icontains(search, autoescape=True),
            ~exists(select(StudioEpisode.id).where(StudioEpisode.project_id == StudioProject.id)),
        )
        series = select(
            StudioSeries.id,
            StudioSeries.title,
            StudioSeries.revision,
            StudioSeries.updated,
            StudioSeries.lifecycle,
            literal("series").label("kind"),
        ).where(
            StudioSeries.owner == owner,
            StudioSeries.lifecycle == lifecycle,
            StudioSeries.title.icontains(search, autoescape=True),
        )
        if mode in {"quick", "storyboard"}:
            projects = projects.where(StudioProject.creation_mode == mode)
            query = projects.subquery()
        elif mode == "series":
            query = series.subquery()
        else:
            query = union_all(projects, series).subquery()
        count = int(await self.session.scalar(select(func.count()).select_from(query)) or 0)
        rows = await self.session.execute(
            select(query)
            .order_by(query.c.updated.desc(), query.c.id)
            .offset((page - 1) * size)
            .limit(size)
        )
        return [dict(row._mapping) for row in rows], count

    async def summaries(self, owner: str, ids: list[str]) -> dict[str, dict[str, Any]]:
        result = {}
        if ids:
            for lifecycle in ("active", "archived"):
                query = (
                    DirectoryDao(self.session)
                    .projects(owner, "", lifecycle)
                    .where(StudioProject.id.in_(ids))
                )
                result.update(
                    {str(row.id): dict(row._mapping) for row in await self.session.execute(query)}
                )
        return result
