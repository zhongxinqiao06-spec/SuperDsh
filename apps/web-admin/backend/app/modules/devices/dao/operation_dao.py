"""设备操作记录的数据访问；授权、事务和恢复策略由服务层管理。"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.devices.entity.do.operation_do import ShellTaskRow, TerminalBindingRow


class OperationDao:
    """单个事务内查询与写入设备收据。"""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def task(self, identifier: str, owner: str) -> ShellTaskRow | None:
        """任务身份不会扩大账号所有权。"""
        row = await self.session.get(ShellTaskRow, identifier)
        return row if row and row.owner_id == owner else None

    async def unfinished(self) -> list[ShellTaskRow]:
        """只查询可能受服务重启影响的运行记录。"""
        return list(
            await self.session.scalars(select(ShellTaskRow).where(ShellTaskRow.state == "running"))
        )

    async def binding(self, identifier: str, owner: str) -> TerminalBindingRow | None:
        """终端绑定需要调用者再核对设备和会话。"""
        row = await self.session.get(TerminalBindingRow, identifier)
        return row if row and row.owner_id == owner else None

    async def save(self, row: ShellTaskRow | TerminalBindingRow) -> None:
        """刷新产生的数据库错误由外层事务统一回滚。"""
        self.session.add(row)
        await self.session.flush()

    async def remove_binding(self, row: TerminalBindingRow) -> None:
        """只在关闭操作完成后解除终端绑定。"""
        await self.session.delete(row)
