"""工具调用与成果元数据仓储，不决定授权、确认或实际执行。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.modules.skills.entity.do.models import ToolExecutionRow


class ExecutionDao:
    def __init__(self, session: AsyncSession) -> None:
        self.db = session

    async def lock(self, identifier: str) -> None:
        await lock_transaction(self.db, "web-admin:tool-execution:" + identifier)

    async def get(self, identifier: str) -> ToolExecutionRow | None:
        return await self.db.get(ToolExecutionRow, identifier)

    async def save(self, row: ToolExecutionRow) -> None:
        self.db.add(row)
        await self.db.flush()

    async def pending(self, owner: str, session: str) -> bool:
        """只查询当前会话未决收据，不能靠列表分页推断无运行任务。"""
        return (
            await self.db.scalar(
                select(ToolExecutionRow.id)
                .where(
                    ToolExecutionRow.owner_id == owner,
                    ToolExecutionRow.session_id == session,
                    ToolExecutionRow.state.in_(["outcome_unknown", "waiting-user"]),
                )
                .limit(1)
            )
            is not None
        )

    async def list(self, owner: str, session: str) -> list[ToolExecutionRow]:
        return list(
            await self.db.scalars(
                select(ToolExecutionRow)
                .where(ToolExecutionRow.owner_id == owner, ToolExecutionRow.session_id == session)
                .order_by(ToolExecutionRow.created_at.desc())
                .limit(200)
            )
        )


class ExecutionRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[ExecutionDao]:
        async with self.database.sessions.begin() as session:
            yield ExecutionDao(session)
