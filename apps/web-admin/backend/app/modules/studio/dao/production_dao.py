"""制作计划和任务的受限查询、行锁与条件状态更新，不提交业务事务。"""

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.studio.entity.do.asset_do import StudioEntity
from app.modules.studio.entity.do.models import MediaJob
from app.modules.studio.entity.do.production_do import GenerationPlan, JobAction


class ProductionDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def entity(self, owner: str, identity: str, *, lock: bool = False) -> StudioEntity:
        query = select(StudioEntity).where(
            StudioEntity.id == identity,
            StudioEntity.owner_id == owner,
            StudioEntity.project_id.is_(None),
        )
        row = await self.session.scalar(
            query.with_for_update().execution_options(populate_existing=True) if lock else query
        )
        if row is None:
            raise DomainError(404, "个人设定不存在")
        return row

    async def personal_jobs(self, owner: str, entity: str) -> list[MediaJob]:
        return list(
            await self.session.scalars(
                select(MediaJob)
                .where(
                    MediaJob.owner == owner,
                    MediaJob.library_entity == entity,
                    MediaJob.project.is_(None),
                )
                .order_by(MediaJob.updated.desc(), MediaJob.id)
            )
        )

    async def plan(self, owner: str, identity: str, *, lock: bool = False) -> GenerationPlan:
        query = select(GenerationPlan).where(
            GenerationPlan.id == identity, GenerationPlan.owner == owner
        )
        row = await self.session.scalar(
            query.with_for_update().execution_options(populate_existing=True) if lock else query
        )
        if not row:
            raise DomainError(404, "制作计划不存在")
        return row

    async def request(self, owner: str, key: str) -> GenerationPlan | None:
        return await self.session.scalar(
            select(GenerationPlan).where(
                GenerationPlan.owner == owner, GenerationPlan.request_key == key
            )
        )

    async def job(self, identity: str, *, lock: bool = False) -> MediaJob:
        query = select(MediaJob).where(MediaJob.id == identity)
        row = await self.session.scalar(
            query.with_for_update().execution_options(populate_existing=True) if lock else query
        )
        if not row:
            raise DomainError(404, "制作任务不存在")
        return row

    async def action(self, owner: str, key: str) -> JobAction | None:
        return await self.session.scalar(
            select(JobAction).where(JobAction.owner == owner, JobAction.request_key == key)
        )

    async def actions(self, owner: str, job: str) -> list[JobAction]:
        return list(
            await self.session.scalars(
                select(JobAction)
                .where(JobAction.owner == owner, JobAction.job == job)
                .order_by(JobAction.created_at.desc())
            )
        )

    async def claim(self, identity: str, expected: str) -> bool:
        value = await self.session.scalar(
            update(MediaJob)
            .where(
                MediaJob.id == identity,
                MediaJob.state == expected,
                MediaJob.cancel_requested.is_(False),
            )
            .values(state="submitting")
            .returning(MediaJob.id)
        )
        return value is not None

    def add(self, value: GenerationPlan | JobAction | MediaJob) -> None:
        self.session.add(value)
