"""存储用量、对象迁移与过期回收，迁移失败不改变有效源对象。"""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.files.entity.do.models import FileCleanupRow, FileMigrationRow
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.files.service.file_service import FileService


class MaintenanceService:
    def __init__(self, files: FileService) -> None:
        self.files = files
        self._cleanup_lock = asyncio.Lock()

    @staticmethod
    def cleanup_receipt(
        owner: str, file_id: str, storage: str, key: str, purpose: str
    ) -> FileCleanupRow:
        """业务事务先登记对象身份，物理 I/O 即使中断也能在下次维护时继续。"""
        now = datetime.now(UTC)
        return FileCleanupRow(
            id="cleanup_" + uuid4().hex,
            owner_id=owner,
            file_id=file_id,
            storage_id=storage,
            object_key=key,
            purpose=purpose,
            state="pending",
            error=None,
            created_at=now,
            updated_at=now,
        )

    async def drain_cleanup(self) -> dict[str, int]:
        """固定平台所有者串行收束删除；离线存储保留失败收据，不阻断平台启动。"""
        removed, pending = 0, 0
        async with self._cleanup_lock:
            async with self.files.repository.transaction() as dao:
                jobs = await dao.pending_cleanup()
            for job in jobs:
                failure = None
                try:
                    await (await self.files.storage.get(job.storage_id)).remove(job.object_key)
                except (DomainError, OSError):
                    failure = "对象清理未完成，检查存储连接后可重试"
                    pending += 1
                async with self.files.repository.transaction() as dao:
                    current = await dao.cleanup_job(job.id)
                    if current:
                        current.state, current.error, current.updated_at = (
                            "failed" if failure else "completed",
                            failure,
                            datetime.now(UTC),
                        )
                        await dao.save(current)
                if not failure and job.purpose == "trash":
                    removed += 1
        return {"removed": removed, "pending": pending}

    async def usage(self, account: Account) -> dict[str, object]:
        """管理统计只汇总元数据，不读取其他用户内容。"""
        account.require("storage.manage")
        async with self.files.repository.transaction() as dao:
            rows = await dao.all_entries()
        totals: dict[str, dict[str, object]] = {}
        for row in rows:
            total = totals.setdefault(
                row.storage_id,
                {
                    "storageId": row.storage_id,
                    "files": 0,
                    "bytes": 0,
                    "trashedFiles": 0,
                    "trashedBytes": 0,
                },
            )
            total["files"] = int(str(total["files"])) + 1
            total["bytes"] = int(str(total["bytes"])) + row.size
            if row.deleted_at:
                total["trashedFiles"] = int(str(total["trashedFiles"])) + 1
                total["trashedBytes"] = int(str(total["trashedBytes"])) + row.size
        return {
            "connections": list(totals.values()),
            "items": [
                {
                    "storage_id": value["storageId"],
                    "objects": str(value["files"]),
                    "bytes": str(value["bytes"]),
                }
                for value in totals.values()
            ],
            "files": len(rows),
            "bytes": sum(row.size for row in rows),
        }

    async def listing(self, account: Account) -> dict[str, object]:
        account.require("storage.manage")
        async with self.files.repository.transaction() as dao:
            rows = await dao.migrations()
            pending = await dao.pending_cleanup()
        counts: dict[str, int] = {}
        for row in rows:
            counts[row.state] = counts.get(row.state, 0) + 1
        return {
            "items": [
                {"state": state, "total": str(total)} for state, total in sorted(counts.items())
            ],
            "records": [
                {
                    "id": row.id,
                    "fileId": row.file_id,
                    "sourceId": row.source_id,
                    "targetId": row.target_id,
                    "state": row.state,
                    "error": row.error,
                    "createdAt": row.created_at.isoformat(),
                    "updatedAt": row.updated_at.isoformat(),
                }
                for row in rows
            ],
            "cleanup": [
                {
                    "id": job.id,
                    "fileId": job.file_id,
                    "storageId": job.storage_id,
                    "state": job.state,
                    "error": job.error,
                }
                for job in pending
            ],
        }

    async def migrate(self, account: Account, identifier: str, target: str) -> dict[str, object]:
        """先复制并校验目标摘要，再原子切换指针；不持锁等待网络。"""
        account.require("storage.manage")
        source = await self.files._row(account, identifier)
        if source.storage_id == target:
            return {"file": self.files.view(source), "state": "completed"}
        adapter = await self.files.storage.get(target, True)
        now = datetime.now(UTC)
        migration = FileMigrationRow(
            id="migration_" + uuid4().hex,
            file_id=identifier,
            owner_id=account.user_id,
            source_id=source.storage_id,
            source_key=source.object_key,
            target_id=target,
            target_key="objects/" + uuid4().hex,
            state="copying",
            error=None,
            created_at=now,
            updated_at=now,
        )
        async with self.files.repository.transaction() as dao:
            await dao.lock(identifier)
            if any(
                row.file_id == identifier and row.state == "copying"
                for row in await dao.migrations(account.user_id)
            ):
                raise DomainError(409, "file migration already active")
            await dao.save(migration)
        try:
            content, _ = await self.files.read(account, identifier)
            await adapter.write(migration.target_key, content, source.media_type)
            check = await adapter.read(migration.target_key)
            if len(check) != source.size or hashlib.sha256(check).hexdigest() != source.sha256:
                raise DomainError(502, "target storage verification failed")
            async with self.files.repository.transaction() as dao:
                await dao.lock(identifier)
                current = await dao.entry(identifier, account.user_id)
                receipt = await dao.migration(migration.id)
                if (
                    not current
                    or current.storage_id != source.storage_id
                    or current.object_key != source.object_key
                    or current.deleted_at
                    or not receipt
                ):
                    raise DomainError(409, "file changed during migration")
                current.storage_id, current.object_key = target, migration.target_key
                receipt.state, receipt.updated_at = "completed", datetime.now(UTC)
                await dao.save(current)
                await dao.save(receipt)
                await dao.save(
                    self.cleanup_receipt(
                        account.user_id,
                        identifier,
                        source.storage_id,
                        source.object_key,
                        "migration",
                    )
                )
                result = self.files.view(current)
        except BaseException:
            async with self.files.repository.transaction() as dao:
                receipt = await dao.migration(migration.id)
                if receipt:
                    receipt.state, receipt.error, receipt.updated_at = (
                        "failed",
                        "对象迁移未完成，源文件仍保留",
                        datetime.now(UTC),
                    )
                    await dao.save(receipt)
                    await dao.save(
                        self.cleanup_receipt(
                            account.user_id, identifier, target, migration.target_key, "migration"
                        )
                    )
            await self.drain_cleanup()
            raise
        cleanup = await self.drain_cleanup()
        return {
            "file": result,
            "state": "completed",
            "migrationId": migration.id,
            "cleanupPending": cleanup["pending"] > 0,
        }

    async def recover(self) -> None:
        """取得唯一平台所有权后收束旧迁移，失败目标可回收、源指针不猜测。"""
        async with self.files.repository.transaction() as dao:
            for receipt in await dao.migrations():
                if receipt.state != "copying":
                    continue
                current = await dao.entry(receipt.file_id, receipt.owner_id)
                if (
                    current
                    and current.storage_id == receipt.target_id
                    and current.object_key == receipt.target_key
                ):
                    receipt.state = "completed"
                    storage, key = receipt.source_id, receipt.source_key
                else:
                    receipt.state, receipt.error = "failed", "服务重启后迁移已中止，可重新发起"
                    storage, key = receipt.target_id, receipt.target_key
                receipt.updated_at = datetime.now(UTC)
                await dao.save(receipt)
                await dao.save(
                    self.cleanup_receipt(
                        receipt.owner_id, receipt.file_id, storage, key, "migration"
                    )
                )
        # 启动只做短暂收束；长时间离线的外部存储不占用平台就绪等待。
        # 取消点之前登记的收据仍保留，下次维护以相同对象键继续幂等删除。
        try:
            async with asyncio.timeout(5):
                await self.drain_cleanup()
        except TimeoutError:
            pass

    async def cleanup(self, account: Account) -> dict[str, object]:
        """回收过期且无引用对象，引用中的历史文件不会被物理删除。"""
        account.require("storage.manage")
        policy = await self.files.storage.policy()
        raw_policy = policy["policy"]
        assert isinstance(raw_policy, dict)
        cutoff = datetime.now(UTC) - timedelta(days=int(str(raw_policy["recycleDays"])))
        async with self.files.repository.transaction() as dao:
            candidates = [
                (row.id, row.owner_id)
                for row in await dao.all_entries()
                if row.deleted_at and row.deleted_at < cutoff
            ]
        scheduled = 0
        for identifier, owner in candidates:
            async with self.files.repository.transaction() as dao:
                await dao.lock(identifier)
                row = await dao.entry(identifier, owner)
                if (
                    not row
                    or not row.deleted_at
                    or row.deleted_at >= cutoff
                    or await dao.references(identifier)
                ):
                    continue
                storage_id, key = row.storage_id, row.object_key
                await dao.save(self.cleanup_receipt(owner, identifier, storage_id, key, "trash"))
                await dao.remove_entry(row)
            scheduled += 1
        result = await self.drain_cleanup()
        await self.files.uploads.recover()
        return {**result, "scheduled": scheduled}
