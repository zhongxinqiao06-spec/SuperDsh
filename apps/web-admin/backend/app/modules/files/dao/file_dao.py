"""文件仓储只进行查询、持久化和锁操作，事务边界由用例选择。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.modules.files.entity.do.models import (
    FileCleanupRow,
    FileEntryRow,
    FileMigrationRow,
    FileReferenceRow,
    FileUploadRow,
    StorageConnectionRow,
    StorageSettingsRow,
)


class FileDao:
    """单个用例事务内的数据访问。"""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def remove_reference(self, row: FileReferenceRow) -> None:
        """仅删除调用方已验证的引用，事务由用例提交。"""
        await self.session.delete(row)

    async def lock(self, key: str) -> None:
        await lock_transaction(self.session, "web-admin:files:" + key)

    async def entry(self, identifier: str, owner: str) -> FileEntryRow | None:
        row = await self.session.get(FileEntryRow, identifier)
        return row if row and row.owner_id == owner else None

    async def entries(self, owner: str) -> list[FileEntryRow]:
        return list(
            await self.session.scalars(
                select(FileEntryRow)
                .where(FileEntryRow.owner_id == owner)
                .order_by(FileEntryRow.created_at.desc(), FileEntryRow.id)
            )
        )

    async def bound_entries(self, owner: str, kind: str, resource: str) -> list[FileEntryRow]:
        """只返回指定资源的真实引用，不由文件名推断关联关系。"""
        return list(
            await self.session.scalars(
                select(FileEntryRow)
                .join(FileReferenceRow, FileReferenceRow.file_id == FileEntryRow.id)
                .where(
                    FileEntryRow.owner_id == owner,
                    FileEntryRow.deleted_at.is_(None),
                    FileReferenceRow.kind == kind,
                    FileReferenceRow.resource_id == resource,
                )
            )
        )

    async def upload(self, identifier: str, owner: str) -> FileUploadRow | None:
        row = await self.session.get(FileUploadRow, identifier)
        return row if row and row.owner_id == owner else None

    async def upload_key(self, owner: str, key: str) -> FileUploadRow | None:
        return await self.session.scalar(
            select(FileUploadRow).where(
                FileUploadRow.owner_id == owner, FileUploadRow.idempotency_key == key
            )
        )

    async def pending_uploads(self) -> list[FileUploadRow]:
        """重启恢复只查询未结算上传，避免扫描已完成历史。"""
        return list(
            await self.session.scalars(
                select(FileUploadRow).where(FileUploadRow.state.in_(["receiving", "completing"]))
            )
        )

    async def all_entries(self) -> list[FileEntryRow]:
        return list(await self.session.scalars(select(FileEntryRow)))

    async def migrations(self, owner: str | None = None) -> list[FileMigrationRow]:
        query = select(FileMigrationRow)
        if owner:
            query = query.where(FileMigrationRow.owner_id == owner)
        return list(
            await self.session.scalars(
                query.order_by(FileMigrationRow.created_at.desc()).limit(1000)
            )
        )

    async def migration(self, identifier: str) -> FileMigrationRow | None:
        return await self.session.get(FileMigrationRow, identifier)

    async def remove_entry(self, row: FileEntryRow) -> None:
        await self.session.delete(row)

    async def pending_cleanup(self) -> list[FileCleanupRow]:
        """仅恢复未成功的物理删除，已完成收据不重复处理。"""
        return list(
            await self.session.scalars(
                select(FileCleanupRow)
                .where(FileCleanupRow.state != "completed")
                .order_by(FileCleanupRow.created_at)
                .limit(1000)
            )
        )

    async def cleanup_job(self, identifier: str) -> FileCleanupRow | None:
        """读取清理收据，事务和授权由服务用例管理。"""
        return await self.session.get(FileCleanupRow, identifier)

    async def connection(self, identifier: str) -> StorageConnectionRow | None:
        return await self.session.get(StorageConnectionRow, identifier)

    async def connections(self) -> list[StorageConnectionRow]:
        return list(
            await self.session.scalars(
                select(StorageConnectionRow).order_by(StorageConnectionRow.id)
            )
        )

    async def settings(self) -> StorageSettingsRow | None:
        return await self.session.get(StorageSettingsRow, "global")

    async def references(self, identifier: str) -> list[FileReferenceRow]:
        return list(
            await self.session.scalars(
                select(FileReferenceRow).where(FileReferenceRow.file_id == identifier)
            )
        )

    async def reference(self, file_id: str, kind: str, resource: str) -> FileReferenceRow | None:
        return await self.session.get(FileReferenceRow, (file_id, kind, resource))

    async def save(
        self,
        row: FileEntryRow
        | FileUploadRow
        | FileReferenceRow
        | StorageConnectionRow
        | StorageSettingsRow
        | FileMigrationRow
        | FileCleanupRow,
    ) -> None:
        self.session.add(row)
        await self.session.flush()


class FileRepository:
    """连接池由应用所有者关闭，服务通过上下文提交或回滚自己的短事务。"""

    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[FileDao]:
        async with self.database.sessions.begin() as session:
            yield FileDao(session)
