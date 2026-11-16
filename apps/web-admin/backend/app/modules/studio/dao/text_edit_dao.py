"""AI 编辑记录仓储；权限、状态迁移与事务由 service 负责。"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.studio.entity.do.models import StudioProject
from app.modules.studio.entity.do.text_edit_do import StudioTextEdit


class TextEditDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def request(self, project: str, key: str) -> StudioTextEdit | None:
        return await self.session.scalar(
            select(StudioTextEdit).where(
                StudioTextEdit.project_id == project, StudioTextEdit.request_key == key
            )
        )

    async def get(self, project: str, identity: str) -> StudioTextEdit:
        row = await self.session.scalar(
            select(StudioTextEdit)
            .where(StudioTextEdit.project_id == project, StudioTextEdit.id == identity)
            .with_for_update()
        )
        if row is None:
            raise DomainError(404, "编辑建议不存在")
        return row

    async def list(self, project: str) -> list[StudioTextEdit]:
        return list(
            await self.session.scalars(
                select(StudioTextEdit)
                .where(StudioTextEdit.project_id == project)
                .order_by(StudioTextEdit.created_at.desc(), StudioTextEdit.id)
                .limit(30)
            )
        )

    def add(self, row: StudioTextEdit) -> None:
        self.session.add(row)

    async def conversation(self, project: str) -> str | None:
        """同一作品的所有编辑意图复用一个 DSH 会话，不创建额外执行队列。"""
        return await self.session.scalar(
            select(StudioTextEdit.target["sessionId"].astext)
            .where(
                StudioTextEdit.project_id == project,
                StudioTextEdit.target["sessionId"].astext.is_not(None),
            )
            .limit(1)
        )

    async def attach(self, project: str, identity: str) -> None:
        for row in await self.list(project):
            if not row.target.get("sessionId"):
                row.target = {**row.target, "sessionId": identity}

    async def by_conversation(self, owner: str, identity: str) -> str | None:
        return await self.session.scalar(
            select(StudioProject.id)
            .join(StudioTextEdit, StudioTextEdit.project_id == StudioProject.id)
            .where(
                StudioProject.owner == owner, StudioTextEdit.target["sessionId"].astext == identity
            )
            .limit(1)
        )
