"""有界分片上传：持久断点、摘要验证、幂等完成与中断清理。"""

import asyncio
import hashlib
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.files.dao.file_dao import FileRepository
from app.modules.files.entity.do.models import FileUploadRow
from app.modules.files.entity.vo.file_dto import UploadInput
from app.modules.files.service.storage_service import StorageService
from app.modules.identity.entity.bo.models import Account

Publish = Callable[
    [Account, str, bytes, str, str | None, str | None, str], Awaitable[dict[str, object]]
]
PART_SIZE = 8 * 1024 * 1024


class UploadService:
    """每个分片写独立文件，短事务切换引用；失败文件在 finally 回收。"""

    def __init__(
        self, repository: FileRepository, storage: StorageService, root: Path, publish: Publish
    ) -> None:
        self.repository, self.storage, self.root, self.publish = repository, storage, root, publish

    async def recover(self) -> None:
        """唯一应用所有者启动后核对提交窗口，已发布文件不重复创建。"""
        stale: list[Path] = []
        async with self.repository.transaction() as dao:
            await dao.lock("upload-recovery")
            for row in await dao.pending_uploads():
                published = await dao.entry("file_" + row.id.removeprefix("upload_"), row.owner_id)
                if published:
                    row.state, row.file_id = "completed", published.id
                elif row.expires_at <= datetime.now(UTC):
                    row.state = "cancelled"
                elif row.state == "completing":
                    row.state = "receiving"
                if row.state in {"completed", "cancelled"}:
                    stale.extend(self.root / str(path) for path in row.parts.values())
                    row.parts = {}
                await dao.save(row)
        for path in stale:
            await asyncio.to_thread(path.unlink, missing_ok=True)

    @staticmethod
    def view(row: FileUploadRow) -> dict[str, object]:
        return {
            "id": row.id,
            "state": row.state,
            "partSize": PART_SIZE,
            "receivedParts": sorted(int(number) for number in row.parts),
            "expiresAt": row.expires_at.isoformat(),
            **({"fileId": row.file_id} if row.file_id else {}),
        }

    async def begin(self, account: Account, body: UploadInput) -> dict[str, object]:
        account.require("files.write")
        settings = await self.storage.policy()
        policy = cast(dict[str, object], settings["policy"])
        if body.size > int(str(policy["maxFileBytes"])):
            raise DomainError(413, "文件超过当前存储限额")
        async with self.repository.transaction() as dao:
            await dao.lock(account.user_id + ":" + body.idempotencyKey)
            row = await dao.upload_key(account.user_id, body.idempotencyKey)
            if row:
                if (row.name, row.size, row.sha256, row.previous_file_id) != (
                    body.name,
                    body.size,
                    body.sha256.lower(),
                    body.previousFileId,
                ):
                    raise DomainError(409, "上传标识已用于不同文件")
                return self.view(row)
            if body.previousFileId:
                previous = await dao.entry(body.previousFileId, account.user_id)
                if not previous or previous.deleted_at:
                    raise DomainError(404, "原文件不存在")
            now = datetime.now(UTC)
            row = FileUploadRow(
                id="upload_" + uuid4().hex,
                owner_id=account.user_id,
                idempotency_key=body.idempotencyKey,
                name=body.name,
                size=body.size,
                sha256=body.sha256.lower(),
                media_type=body.mediaType,
                storage_id=str(settings["activeConnectionId"]),
                previous_file_id=body.previousFileId,
                state="receiving",
                parts={},
                file_id=None,
                created_at=now,
                expires_at=now + timedelta(hours=int(str(policy["temporaryHours"]))),
            )
            await dao.save(row)
            return self.view(row)

    async def status(self, account: Account, identifier: str) -> dict[str, object]:
        account.require("files.read")
        async with self.repository.transaction() as dao:
            row = await dao.upload(identifier, account.user_id)
            if not row:
                raise DomainError(404, "上传记录不存在")
            return self.view(row)

    async def part(
        self, account: Account, identifier: str, number: int, content: bytes
    ) -> dict[str, object]:
        account.require("files.write")
        async with self.repository.transaction() as dao:
            row = await dao.upload(identifier, account.user_id)
            if not row or row.state != "receiving" or row.expires_at <= datetime.now(UTC):
                raise DomainError(409, "上传已关闭或过期")
            count = (row.size + PART_SIZE - 1) // PART_SIZE
            expected = row.size - (number - 1) * PART_SIZE if number == count else PART_SIZE
            if not 1 <= number <= count or len(content) != expected:
                raise DomainError(422, "上传分片大小或序号不正确")
        await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True)
        path = self.root / uuid4().hex
        old: Path | None = None
        retained = False
        try:
            await asyncio.to_thread(path.write_bytes, content)
            async with self.repository.transaction() as dao:
                await dao.lock(identifier)
                current = await dao.upload(identifier, account.user_id)
                if (
                    not current
                    or current.state != "receiving"
                    or current.expires_at <= datetime.now(UTC)
                ):
                    raise DomainError(409, "上传已关闭或过期")
                prior = current.parts.get(str(number))
                if isinstance(prior, str):
                    old = self.root / prior
                current.parts = {**current.parts, str(number): path.name}
                await dao.save(current)
            retained = True
        finally:
            if not retained:
                await asyncio.to_thread(path.unlink, missing_ok=True)
            if retained and old:
                await asyncio.to_thread(old.unlink, missing_ok=True)
        return await self.status(account, identifier)

    async def complete(self, account: Account, identifier: str) -> dict[str, object]:
        account.require("files.write")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.upload(identifier, account.user_id)
            if not row:
                raise DomainError(404, "上传记录不存在")
            if row.state == "completed" and row.file_id:
                entry = await dao.entry(row.file_id, account.user_id)
                if not entry:
                    raise DomainError(409, "上传文件已不可用")
                from app.modules.files.service.file_service import FileService

                return FileService.view(entry)
            if row.state != "receiving" or row.expires_at <= datetime.now(UTC):
                raise DomainError(409, "上传正在完成、已关闭或过期")
            count = (row.size + PART_SIZE - 1) // PART_SIZE
            if sorted(int(part) for part in row.parts) != list(range(1, count + 1)):
                raise DomainError(409, "上传分片尚未收齐")
            row.state = "completing"
            await dao.save(row)
            paths = [self.root / str(row.parts[str(number)]) for number in range(1, count + 1)]
        try:
            buffers = [await asyncio.to_thread(path.read_bytes) for path in paths]
            content = b"".join(buffers)
            if len(content) != row.size or hashlib.sha256(content).hexdigest() != row.sha256:
                raise DomainError(422, "文件大小或 SHA-256 校验失败")
            published = await self.publish(
                account,
                row.name,
                content,
                row.media_type,
                row.previous_file_id,
                row.storage_id,
                row.id,
            )
            async with self.repository.transaction() as dao:
                await dao.lock(identifier)
                current = await dao.upload(identifier, account.user_id)
                assert current is not None
                current.state, current.file_id = "completed", str(published["id"])
                await dao.save(current)
            for path in paths:
                await asyncio.to_thread(path.unlink, missing_ok=True)
            return published
        except BaseException:
            async with self.repository.transaction() as dao:
                await dao.lock(identifier)
                current = await dao.upload(identifier, account.user_id)
                if current and current.state == "completing":
                    current.state = "receiving"
                    await dao.save(current)
            raise

    async def cancel(self, account: Account, identifier: str) -> dict[str, object]:
        account.require("files.write")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.upload(identifier, account.user_id)
            if not row:
                raise DomainError(404, "上传记录不存在")
            if row.state in {"completed", "completing"}:
                raise DomainError(409, "文件已完成或正在提交")
            paths = [self.root / str(value) for value in row.parts.values()]
            row.state, row.parts = "cancelled", {}
            await dao.save(row)
        for path in paths:
            await asyncio.to_thread(path.unlink, missing_ok=True)
        return await self.status(account, identifier)
