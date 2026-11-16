"""作品规格、归档和幂等回执仓储。"""

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.studio.entity.do.foundation_do import ProjectSnapshot, StudioCommand
from app.modules.studio.entity.do.models import StudioProject


class FoundationDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def creation(self, owner: str, key: str) -> StudioProject | None:
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
            {"key": "studio-create:" + owner + ":" + key},
        )
        return await self.session.scalar(
            select(StudioProject).where(
                StudioProject.owner == owner, StudioProject.creation_key == key
            )
        )

    async def command(self, owner: str, project: str, key: str) -> StudioCommand | None:
        return await self.session.scalar(
            select(StudioCommand).where(
                StudioCommand.owner_id == owner,
                StudioCommand.project_id == project,
                StudioCommand.operation_key == key,
            )
        )

    def remember(self, record: StudioCommand) -> None:
        self.session.add(record)

    def add_project(self, project: StudioProject) -> None:
        self.session.add(project)

    async def snapshot(self, project: str, revision: int) -> ProjectSnapshot | None:
        return await self.session.get(ProjectSnapshot, (project, revision))
