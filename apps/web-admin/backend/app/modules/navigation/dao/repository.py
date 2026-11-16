"""菜单 DAO 只做数据读写，不决定权限、冲突或默认初始化。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.modules.navigation.entity.bo.navigation import Navigation, Product
from app.modules.navigation.entity.do.models import NavigationRow
from app.modules.navigation.service.ports import NavigationTransaction


class SqlNavigationTransaction:
    """服务上下文中的菜单数据访问对象。"""

    def __init__(self, session: AsyncSession, product: Product) -> None:
        self.db = session
        # 办公继续使用历史主键，升级无需复制已有自定义菜单或改变其并发版本。
        self.key = "global" if product == "office" else product

    async def lock(self) -> None:
        lock = (
            "web-admin:navigation" if self.key == "global" else "web-admin:navigation:" + self.key
        )
        await lock_transaction(self.db, lock)

    async def read(self) -> Navigation | None:
        row = await self.db.get(NavigationRow, self.key)
        return Navigation(row.version, row.items) if row else None

    async def save(self, navigation: Navigation, actor: str | None) -> None:
        await self.db.merge(
            NavigationRow(
                id=self.key, version=navigation.version, items=navigation.items, updated_by=actor
            )
        )


class SqlNavigationRepository:
    """创建受管连接，事务范围由 service 的上下文控制。"""

    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self, product: Product) -> AsyncIterator[NavigationTransaction]:
        async with self.database.sessions.begin() as session:
            yield SqlNavigationTransaction(session, product)
