"""创作确认、草案和媒体候选仓储，不执行权限决策或提交事务。"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.studio.entity.do.preparation_do import StageReview, StudioProposal


class PreparationDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def reviews(self, project: str) -> list[StageReview]:
        return list(
            await self.session.scalars(
                select(StageReview)
                .where(StageReview.project_id == project)
                .order_by(StageReview.created_at.desc(), StageReview.id.desc())
            )
        )

    async def proposal(self, project: str, identifier: str) -> StudioProposal | None:
        return await self.session.scalar(
            select(StudioProposal).where(
                StudioProposal.project_id == project, StudioProposal.id == identifier
            )
        )

    async def request(self, project: str, key: str) -> StudioProposal | None:
        return await self.session.scalar(
            select(StudioProposal).where(
                StudioProposal.project_id == project, StudioProposal.request_key == key
            )
        )

    def add(self, value: StageReview | StudioProposal) -> None:
        self.session.add(value)
