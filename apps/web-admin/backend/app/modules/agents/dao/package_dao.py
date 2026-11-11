"""配置包初始化的会话锁；不持有数据库事务等待资料生成或解析。"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection


class PackageDao:
    """锁与专用连接同寿命，进程退出后由 PostgreSQL 自动释放。"""

    def __init__(self, session: AsyncConnection) -> None:
        self.session = session

    async def acquire(self, owner: str) -> bool:
        """争用立即返回，不通过新锁名绕过已有初始化。"""
        return bool(
            await self.session.scalar(
                text("SELECT pg_try_advisory_lock(hashtextextended(:key, 0))"),
                {"key": "web-admin:examples:" + owner},
            )
        )

    async def release(self, owner: str) -> None:
        """只在原持锁连接解锁，不重连。"""
        await self.session.execute(
            text("SELECT pg_advisory_unlock(hashtextextended(:key, 0))"),
            {"key": "web-admin:examples:" + owner},
        )
