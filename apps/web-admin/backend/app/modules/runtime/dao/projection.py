"""运行投影 DAO 只访问数据库；事务提交和业务校验由 service 负责。"""

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.runtime.entity.do.models import (
    RuntimeBatch,
    RuntimeCheckpoint,
    RuntimeExecutionFence,
    RuntimeReceipt,
)


class ProjectionDao:
    """绑定调用方的短事务 session，不自行提交或回滚。"""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def batch(self, owner: str, stream: str, sequence: int) -> RuntimeBatch | None:
        """按所有者和流序列读取幂等批次。"""
        return await self.session.scalar(
            select(RuntimeBatch).where(
                RuntimeBatch.owner == owner,
                RuntimeBatch.stream == stream,
                RuntimeBatch.sequence == sequence,
            )
        )

    async def checkpoint(self, owner: str, external: str) -> RuntimeCheckpoint | None:
        """读取当前用户原生会话 checkpoint。"""
        return await self.session.get(RuntimeCheckpoint, (owner, external))

    async def delete_checkpoint(self, row: RuntimeCheckpoint) -> None:
        """删除已由用例确认身份的 checkpoint。"""
        await self.session.delete(row)

    async def events(self, owner: str, after: int) -> Sequence[RuntimeBatch]:
        """按持久游标分页，限制单次读取规模。"""
        return (
            await self.session.scalars(
                select(RuntimeBatch)
                .where(RuntimeBatch.owner == owner, RuntimeBatch.id > after)
                .order_by(RuntimeBatch.id)
                .limit(100)
            )
        ).all()

    async def receipt(self, owner: str, identifier: str) -> RuntimeReceipt | None:
        """读取稳定消息键的持久收据。"""
        return await self.session.get(RuntimeReceipt, (owner, identifier))

    async def fence(self, owner: str) -> RuntimeExecutionFence | None:
        """读取执行者栅栏，调用方已经持有该用户的独占运行锁。"""
        return await self.session.get(RuntimeExecutionFence, owner)

    async def delete_fence(self, row: RuntimeExecutionFence) -> None:
        """仅删除 service 已核实代际和退出状态的栅栏。"""
        await self.session.delete(row)

    def add(
        self, row: RuntimeBatch | RuntimeCheckpoint | RuntimeReceipt | RuntimeExecutionFence
    ) -> None:
        """把已校验实体纳入当前事务，提交权留给 service。"""
        self.session.add(row)
