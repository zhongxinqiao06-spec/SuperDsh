"""异步 PostgreSQL 连接与短事务；生命周期由应用装配统一持有。"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """全部新平台 ORM 使用同一 metadata，迁移历史由 Alembic 管理。"""


class Database:
    """限制连接/语句等待；业务仓储自行控制事务，不在请求导入时建表。"""

    def __init__(self, url: str) -> None:
        self.engine: AsyncEngine = create_async_engine(
            url,
            pool_pre_ping=True,
            pool_size=10,
            max_overflow=5,
            pool_timeout=10,
            connect_args={
                "timeout": 10,
                "command_timeout": 30,
                "server_settings": {"statement_timeout": "30000", "lock_timeout": "10000"},
            },
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def ready(self) -> bool:
        """真实检查数据库连通性，异常由健康端点转为依赖失败。"""
        async with self.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        return True

    async def close(self) -> None:
        """应用退出时释放池，先由运行服务回收长期租约。"""
        await self.engine.dispose()

    async def schema_version(self) -> str | None:
        """健康诊断读取真实迁移记录，不把旧平台或发布版本硬编码为数据库版本。"""
        async with self.engine.connect() as connection:
            value = await connection.scalar(text("SELECT version_num FROM alembic_version"))
        return str(value) if value is not None else None


async def lock_transaction(session: AsyncSession, key: str) -> None:
    """跨进程串行化同一短事务，锁随事务释放；不用于等待用户。"""
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": key}
    )
