"""扩展查询和行写入，事务提交由来源服务控制。"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.extensions.entity.do.models import ExtensionSourceRow, ExtensionVersionRow


class ExtensionDao:
    """只处理本域数据，不在持久化层发起进程或网络请求。"""

    @staticmethod
    async def sources(session: AsyncSession) -> list[ExtensionSourceRow]:
        return list(
            await session.scalars(
                select(ExtensionSourceRow).order_by(ExtensionSourceRow.name, ExtensionSourceRow.id)
            )
        )

    @staticmethod
    async def source(session: AsyncSession, identifier: str) -> ExtensionSourceRow | None:
        return await session.get(ExtensionSourceRow, identifier)

    @staticmethod
    async def versions(session: AsyncSession, identifier: str) -> list[ExtensionVersionRow]:
        return list(
            await session.scalars(
                select(ExtensionVersionRow)
                .where(ExtensionVersionRow.source_id == identifier)
                .order_by(ExtensionVersionRow.created_at.desc())
            )
        )

    @staticmethod
    async def version(
        session: AsyncSession, identifier: str, version: str
    ) -> ExtensionVersionRow | None:
        return await session.get(ExtensionVersionRow, (identifier, version))

    @staticmethod
    async def save_source(session: AsyncSession, row: ExtensionSourceRow) -> None:
        session.add(row)
        await session.flush()

    @staticmethod
    async def add_version(session: AsyncSession, row: ExtensionVersionRow) -> None:
        session.add(row)
        await session.flush()
