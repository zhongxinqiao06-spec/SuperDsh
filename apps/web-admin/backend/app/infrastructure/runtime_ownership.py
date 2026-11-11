"""专用 PostgreSQL 连接持有 advisory lock；连接故障立即失去执行资格。"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from app.integrations.dsh.protocol import RuntimeFailure


class PostgresOwnership:
    """不得复用事务池连接；进程树终止后才显式释放租约。"""

    def __init__(self, connection: AsyncConnection, key: int) -> None:
        self.connection = connection
        self.key = key
        self.valid = True
        self._lock = asyncio.Lock()

    async def check(self) -> bool:
        """心跳只使用持锁连接，禁止重连后误认为仍然拥有锁。"""
        async with self._lock:
            if not self.valid or self.connection.invalidated or self.connection.closed:
                return False
            try:
                await asyncio.wait_for(self.connection.execute(text("SELECT 1")), 3)
                await self.connection.commit()
                return True
            except Exception:
                self.valid = False
                return False

    async def release(self) -> None:
        """幂等释放；连接失效时只关闭，不建立新连接解锁。"""
        async with self._lock:
            if self.connection.closed:
                return
            try:
                if self.valid and not self.connection.invalidated:
                    await self.connection.execute(
                        text("SELECT pg_advisory_unlock(:key)"), {"key": self.key}
                    )
                    await self.connection.commit()
            finally:
                self.valid = False
                with contextlib.suppress(Exception):
                    await self.connection.close()


class PostgresOwnershipProvider:
    """锁键由固定领域命名空间和所有者生成，争用不会换名重试。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self.engine = engine

    async def acquire(self, owner: str) -> PostgresOwnership:
        """原子申请所有权；SQLite 等不具备该能力的数据库明确拒绝。"""
        if self.engine.dialect.name != "postgresql":
            raise RuntimeFailure("runtime_requires_postgresql", "执行租约要求 PostgreSQL")
        key = int.from_bytes(
            hashlib.sha256(f"superdsh:web-admin:runtime:{owner}".encode()).digest()[:8],
            "big",
            signed=True,
        )
        connection = await self.engine.connect()
        try:
            acquired = await connection.scalar(
                text("SELECT pg_try_advisory_lock(:key)"), {"key": key}
            )
            await connection.commit()
            if not acquired:
                raise RuntimeFailure("runtime_owned_elsewhere", "运行时由另一实例管理", 409)
            return PostgresOwnership(connection, key)
        except BaseException:
            await connection.close()
            raise
