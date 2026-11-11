"""菜单 DAO 只做数据读写，不决定权限、冲突或默认初始化。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.modules.navigation.entity.bo.navigation import Navigation
from app.modules.navigation.entity.do.models import NavigationRow
from app.modules.navigation.service.ports import NavigationTransaction


class SqlNavigationTransaction:
    """服务上下文中的菜单数据访问对象。"""

    def __init__(self, session: AsyncSession) -> None:
        self.db = session

    async def lock(self) -> None:
        await lock_transaction(self.db, "web-admin:navigation")

    async def read(self) -> Navigation | None:
        row = await self.db.get(NavigationRow, "global")
        return Navigation(row.version, row.items) if row else None

    async def save(self, navigation: Navigation, actor: str | None) -> None:
        await self.db.merge(
            NavigationRow(
                id="global", version=navigation.version, items=navigation.items, updated_by=actor
            )
        )


class SqlNavigationRepository:
    """创建受管连接，事务范围由 service 的上下文控制。"""

    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[NavigationTransaction]:
        async with self.database.sessions.begin() as session:
            yield SqlNavigationTransaction(session)
