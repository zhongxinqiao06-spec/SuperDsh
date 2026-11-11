"""系统设置仓储仅负责查询与写入，事务提交由公开 service 管理。"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database
from app.modules.management.entity.do.models import DashboardSnapshotRow, SettingRow


class SqlManagementRepository:
    """向系统用例提供会话工厂和本领域记录访问。"""

    def __init__(self, database: Database) -> None:
        self.sessions = database.sessions

    async def setting(self, session: AsyncSession, key: str) -> SettingRow | None:
        return await session.get(SettingRow, key)

    async def save_setting(self, session: AsyncSession, row: SettingRow) -> None:
        await session.merge(row)
        await session.flush()

    async def snapshot(self, session: AsyncSession, key: str) -> DashboardSnapshotRow | None:
        return await session.get(DashboardSnapshotRow, key)

    async def snapshots(self, session: AsyncSession, keys: list[str]) -> list[DashboardSnapshotRow]:
        """按请求日期批量读取，历史总览不会对每一天执行独立查询。"""
        return list(
            await session.scalars(
                select(DashboardSnapshotRow).where(DashboardSnapshotRow.key.in_(keys))
            )
        )

    async def save_snapshot(self, session: AsyncSession, row: DashboardSnapshotRow) -> None:
        await session.merge(row)
