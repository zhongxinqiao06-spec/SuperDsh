"""设备数据访问，不推导权限、不启动进程。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.modules.devices.entity.do.models import DeviceRow, DeviceRuntimeRow, PairingRow


class DeviceDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def lock(self, key: str) -> None:
        await lock_transaction(self.session, "web-admin:device:" + key)

    async def device(self, identifier: str) -> DeviceRow | None:
        return await self.session.get(DeviceRow, identifier)

    async def devices(self, owner: str | None = None) -> list[DeviceRow]:
        query = select(DeviceRow).where(DeviceRow.revoked.is_(False))
        if owner:
            query = query.where(DeviceRow.owner_id == owner)
        return list(
            await self.session.scalars(query.order_by(DeviceRow.updated_at.desc(), DeviceRow.id))
        )

    async def runtimes(self, identifier: str) -> list[DeviceRuntimeRow]:
        return list(
            await self.session.scalars(
                select(DeviceRuntimeRow)
                .where(DeviceRuntimeRow.connector_id == identifier)
                .order_by(DeviceRuntimeRow.runtime_id)
            )
        )

    async def runtime(self, connector: str, identifier: str) -> DeviceRuntimeRow | None:
        return await self.session.get(DeviceRuntimeRow, (connector, identifier))

    async def pairing(self, identifier: str) -> PairingRow | None:
        return await self.session.get(PairingRow, identifier)

    async def pairing_code(self, code: str) -> PairingRow | None:
        return await self.session.scalar(
            select(PairingRow)
            .where(PairingRow.code_hash == code)
            .order_by(PairingRow.expires_at.desc())
            .limit(1)
        )

    async def save(self, row: DeviceRow | DeviceRuntimeRow | PairingRow) -> None:
        self.session.add(row)
        await self.session.flush()


class DeviceRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[DeviceDao]:
        async with self.database.sessions.begin() as session:
            yield DeviceDao(session)
