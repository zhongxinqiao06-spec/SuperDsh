"""文件所有权、版本、引用与内容校验用例，不信任下载地址或文件名。"""

import asyncio
import hashlib
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import uuid4

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.files.dao.file_dao import FileRepository
from app.modules.files.entity.bo.session_attachment import attachment_identity
from app.modules.files.entity.do.models import FileEntryRow, FileReferenceRow
from app.modules.files.service.content import media_type
from app.modules.files.service.maintenance_service import MaintenanceService
from app.modules.files.service.session_attachment_service import SessionAttachmentService
from app.modules.files.service.storage_service import StorageService
from app.modules.files.service.upload_service import UploadService
from app.modules.identity.entity.bo.models import Account


class FileService:
    """应用级文件入口，其他领域只通过该服务引用和读取对象。"""

    def __init__(self, database: Database, data_dir: Path, cipher: CredentialCipher) -> None:
        self.repository = FileRepository(database)
        self.root = data_dir / "files"
        self.storage = StorageService(self.repository, self.root, cipher)
        self.uploads = UploadService(
            self.repository, self.storage, self.root / "staging", self._publish_upload
        )
        self.maintenance = MaintenanceService(self)
        self.session_attachments = SessionAttachmentService(self)

    async def initialize(self) -> None:
        """启动只初始化存储记录，磁盘目录在首次写入时创建。"""
        await self.storage.initialize()
        await self.uploads.recover()
        await self.maintenance.recover()

    @staticmethod
    def view(row: FileEntryRow) -> dict[str, object]:
        return {
            "id": row.id,
            "ownerUserId": row.owner_id,
            "name": row.name,
            "size": row.size,
            "sha256": row.sha256,
            "mediaType": row.media_type,
            "category": row.category,
            "version": row.version,
            "previousFileId": row.previous_file_id,
            "storageId": row.storage_id,
            "createdAt": row.created_at.isoformat(),
            "deletedAt": row.deleted_at.isoformat() if row.deleted_at else None,
            "downloadUrl": f"/api/files/{row.id}/content",
            "references": [],
        }

    async def describe(self, row: FileEntryRow) -> dict[str, object]:
        """已授权文件的公开快照补充引用，不返回存储对象键或目录。"""
        async with self.repository.transaction() as dao:
            references = await dao.references(row.id)
        return {
            **self.view(row),
            "references": [
                {"fileId": row.id, "kind": value.kind, "resourceId": value.resource_id}
                for value in references
            ],
        }

    async def _row(
        self,
        account: Account,
        identifier: str,
        deleted: bool = False,
        permission: str = "files.read",
    ) -> FileEntryRow:
        account.require(permission)
        async with self.repository.transaction() as dao:
            row = await dao.entry(identifier, account.user_id)
            if not row or row.deleted_at and not deleted:
                raise DomainError(404, "file not found")
            return row

    async def entry(self, account: Account, file_id: str) -> dict[str, object]:
        """只展示本人文件，管理员运维权限不会扩大内容所有权。"""
        return await self.describe(await self._row(account, file_id))

    async def list_entries(
        self, account: Account, filters: dict[str, object] | None = None
    ) -> dict[str, object]:
        account.require("files.read")
        query = filters or {}
        page, size = (
            max(1, int(str(query.get("page", 1)))),
            min(100, max(1, int(str(query.get("pageSize", 20))))),
        )
        async with self.repository.transaction() as dao:
            rows = await dao.entries(account.user_id)
        search = str(query.get("search", query.get("q", ""))).casefold()
        deleted = str(query.get("deleted", query.get("trashed", "false"))).lower() == "true"
        category = str(query.get("category", ""))
        rows = [
            row
            for row in rows
            if bool(row.deleted_at) == deleted
            and search in row.name.casefold()
            and (not category or row.category == category)
        ]
        return {
            "items": [await self.describe(row) for row in rows[(page - 1) * size : page * size]],
            "total": len(rows),
            "page": page,
            "pageSize": size,
        }

    async def read(self, account: Account, file_id: str) -> tuple[bytes, dict[str, object]]:
        """读取后核对大小和摘要，不向调用者提供未提交对象。"""
        row = await self._row(account, file_id)
        return await self._content(row)

    async def read_bound(
        self,
        account: Account,
        file_id: str,
        kind: str,
        resource_id: str,
        permission: str = "files.read",
    ) -> tuple[bytes, dict[str, object]]:
        """引用下载同时证明资源授权和文件确实绑定该资源。"""
        try:
            row = await self._row(account, file_id, permission=permission)
        except DomainError as error:
            if error.status != 404 or kind != "session":
                raise
            row = await self._row(
                account,
                attachment_identity(account.user_id, resource_id, file_id),
                permission=permission,
            )
        async with self.repository.transaction() as dao:
            if not await dao.reference(row.id, kind, resource_id):
                raise DomainError(404, "attachment not found")
        return await self._content(row)

    async def stage_session(
        self, account: Account, session_id: str, values: list[dict[str, object]]
    ) -> list[tuple[str, bytes, dict[str, object]]]:
        """供已授权会话执行使用的公开附件入口，业务层不访问文件DAO或存储。"""
        return await self.session_attachments.stage(account, session_id, values)

    async def read_reference(
        self, account: Account, kind: str, resource: str, name: str, hash_prefix: str | None = None
    ) -> tuple[bytes, dict[str, object]]:
        """已授权资源内按精确名称和可选摘要查附件，重名时要求明确摘要。"""
        account.require("files.read")
        async with self.repository.transaction() as dao:
            rows = await dao.bound_entries(account.user_id, kind, resource)
        if hash_prefix is not None and (
            not 8 <= len(hash_prefix) <= 64
            or any(char not in "0123456789abcdefABCDEF" for char in hash_prefix)
        ):
            raise DomainError(422, "invalid attachment digest prefix")
        selected = [
            row
            for row in rows
            if row.name == name
            and (hash_prefix is None or row.sha256.startswith(hash_prefix.lower()))
        ]
        if not selected:
            raise DomainError(404, "attachment not found")
        if len(selected) > 1:
            raise DomainError(422, "attachment name is ambiguous; specify its digest")
        return await self._content(selected[0])

    async def _content(self, row: FileEntryRow) -> tuple[bytes, dict[str, object]]:
        data = await (await self.storage.get(row.storage_id)).read(row.object_key)
        if len(data) != row.size or hashlib.sha256(data).hexdigest() != row.sha256:
            raise DomainError(500, "stored file metadata does not match content")
        return data, self.view(row)

    async def ingest_asset(
        self,
        account: Account,
        name: str,
        data: bytes,
        media_type: str,
        reference: dict[str, object] | None = None,
    ) -> dict[str, object]:
        """Agent 资产沿用领域授权，所有权与内容校验仍由统一文件库执行。"""
        value = await self._ingest(account, name, data, media_type, None, None, "agents.manage")
        if reference:
            await self.bind_asset(
                account, str(value["id"]), str(reference["kind"]), str(reference["resourceId"])
            )
        return value

    async def read_asset(self, account: Account, file_id: str) -> tuple[bytes, dict[str, object]]:
        """仅允许 Agent 管理者读取本人资产，不扩大普通文件下载入口。"""
        return await self._content(await self._row(account, file_id, permission="agents.manage"))

    async def read_owned_asset(
        self, owner_id: str, file_id: str
    ) -> tuple[bytes, dict[str, object]]:
        """受信领域在冻结绑定授权后读取发布者资产；禁止直接暴露为 HTTP 入口。"""
        async with self.repository.transaction() as dao:
            row = await dao.entry(file_id, owner_id)
        if not row or row.deleted_at:
            raise DomainError(404, "asset file not found")
        return await self._content(row)

    async def unbind_asset(
        self, account: Account, file_id: str, kind: str, resource_id: str
    ) -> None:
        """领域删除关联时只撤销指定引用，不影响其他冻结绑定。"""
        await self._row(account, file_id, permission="agents.manage")
        async with self.repository.transaction() as dao:
            await dao.lock(file_id)
            reference = await dao.reference(file_id, kind, resource_id)
            if reference:
                await dao.remove_reference(reference)

    async def remove_asset(self, account: Account, file_id: str) -> None:
        """失败补偿仅回收没有引用的本人资产，保留已提交资源内容。"""
        await self._row(account, file_id, deleted=True, permission="agents.manage")
        async with self.repository.transaction() as dao:
            await dao.lock(file_id)
            if await dao.references(file_id):
                raise DomainError(409, "asset is referenced")
            row = await dao.entry(file_id, account.user_id)
            if row:
                row.deleted_at = datetime.now(UTC)
                await dao.save(row)

    async def bind_asset(
        self, account: Account, file_id: str, kind: str, resource_id: str
    ) -> dict[str, object]:
        """资产关联不要求文件库页面权限，但始终验证同一所有者。"""
        return await self._bind(account, file_id, kind, resource_id, "agents.manage")

    async def ingest(
        self,
        account: Account,
        name: str,
        data: bytes,
        media_type: str,
        reference: dict[str, object] | None = None,
    ) -> dict[str, object]:
        """Agent、知识和成果复用同一存储；写入完成后才发布文件身份。"""
        value = await self._ingest(account, name, data, media_type, None, None)
        if reference:
            await self.bind(
                account, str(value["id"]), str(reference["kind"]), str(reference["resourceId"])
            )
        return value

    async def ingest_artifact(
        self,
        account: Account,
        name: str,
        data: bytes,
        media_type: str,
        artifact_id: str,
        session_id: str,
    ) -> dict[str, object]:
        """已验证成果通过稳定文件身份进入当前存储策略，发布重试不复制文件。"""
        if not artifact_id or len(artifact_id) > 80 or not session_id:
            raise DomainError(422, "invalid artifact publication identity")
        value = await self._ingest(
            account, name, data, media_type, None, None, "files.write", "file_" + artifact_id
        )
        await self.bind(account, str(value["id"]), "artifact", artifact_id)
        return await self.bind(account, str(value["id"]), "session", session_id)

    async def _publish_upload(
        self,
        account: Account,
        name: str,
        data: bytes,
        claimed: str,
        previous: str | None,
        storage_id: str | None,
        upload_id: str,
    ) -> dict[str, object]:
        """上传身份确定文件身份，完成提交窗口崩溃后可安全核对重放。"""
        return await self._ingest(
            account,
            name,
            data,
            claimed,
            previous,
            storage_id,
            file_id="file_" + upload_id.removeprefix("upload_"),
        )

    async def _ingest(
        self,
        account: Account,
        name: str,
        data: bytes,
        claimed: str,
        previous: str | None,
        storage_id: str | None,
        permission: str = "files.write",
        file_id: str | None = None,
    ) -> dict[str, object]:
        account.require(permission)
        if file_id:
            async with self.repository.transaction() as dao:
                existing = await dao.entry(file_id, account.user_id)
                if existing:
                    if existing.deleted_at or existing.sha256 != hashlib.sha256(data).hexdigest():
                        raise DomainError(409, "file publication conflict")
                    return self.view(existing)
        from app.modules.files.entity.vo.file_dto import UploadInput

        try:
            name = UploadInput.safe_name(name)
        except ValueError as error:
            raise DomainError(422, "invalid file name") from error
        if len(name) > 512:
            raise DomainError(422, "invalid file name")
        policy = await self.storage.policy()
        maximum = cast(dict[str, object], policy["policy"])["maxFileBytes"]
        if not data or len(data) > int(str(maximum)):
            raise DomainError(413, "file is too large or empty")
        actual = await asyncio.to_thread(media_type, data, name, claimed)
        chosen = storage_id or str(policy["activeConnectionId"])
        storage = await self.storage.get(chosen, True)
        key = "objects/" + uuid4().hex
        try:
            await storage.write(key, data, actual)
            duplicate = None
            async with self.repository.transaction() as dao:
                # 并发发布允许先写独立对象，但稳定身份只在短事务中结算一次。
                if file_id:
                    await dao.lock(file_id)
                    duplicate = await dao.entry(file_id, account.user_id)
                    if duplicate and (
                        duplicate.deleted_at or duplicate.sha256 != hashlib.sha256(data).hexdigest()
                    ):
                        raise DomainError(409, "file publication conflict")
                old = await dao.entry(previous, account.user_id) if previous else None
                if previous and (not old or old.deleted_at):
                    raise DomainError(404, "原文件不存在")
                row = FileEntryRow(
                    id=file_id or "file_" + uuid4().hex,
                    owner_id=account.user_id,
                    storage_id=chosen,
                    object_key=key,
                    name=name,
                    size=len(data),
                    sha256=hashlib.sha256(data).hexdigest(),
                    media_type=actual,
                    category=actual.split("/", 1)[0]
                    if actual.startswith(("image/", "audio/", "video/"))
                    else "document"
                    if "text" in actual or "pdf" in actual or "officedocument" in actual
                    else "other",
                    version=old.version + 1 if old else 1,
                    previous_file_id=previous,
                    created_at=datetime.now(UTC),
                    deleted_at=None,
                )
                if not duplicate:
                    await dao.save(row)
            if duplicate:
                await storage.remove(key)
                return self.view(duplicate)
            return self.view(row)
        except BaseException:
            await storage.remove(key)
            raise

    async def bind(
        self, account: Account, file_id: str, kind: str, resource_id: str
    ) -> dict[str, object]:
        """调用领域先校验资源所有权，此处再校验文件所有权，重复绑定幂等。"""
        return await self._bind(account, file_id, kind, resource_id, "files.write")

    async def _bind(
        self, account: Account, file_id: str, kind: str, resource_id: str, permission: str
    ) -> dict[str, object]:
        row = await self._row(account, file_id, permission=permission)
        if (
            kind not in {"session", "agent", "knowledge", "asset", "artifact", "avatar"}
            or not resource_id
            or len(resource_id) > 100
        ):
            raise DomainError(422, "invalid file reference")
        async with self.repository.transaction() as dao:
            await dao.lock(file_id)
            current = await dao.entry(file_id, account.user_id)
            if not current or current.deleted_at:
                raise DomainError(404, "文件不存在或已回收")
            if not await dao.reference(file_id, kind, resource_id):
                await dao.save(
                    FileReferenceRow(
                        file_id=file_id,
                        kind=kind,
                        resource_id=resource_id,
                        owner_id=account.user_id,
                    )
                )
        return await self.describe(row)

    async def trash(
        self, account: Account, file_id: str, restore: bool = False
    ) -> dict[str, object]:
        account.require("files.write")
        async with self.repository.transaction() as dao:
            await dao.lock(file_id)
            row = await dao.entry(file_id, account.user_id)
            if not row:
                raise DomainError(404, "file not found")
            if not restore and await dao.references(file_id):
                raise DomainError(409, "文件仍被会话、知识或成果引用，请先解除引用")
            row.deleted_at = None if restore else datetime.now(UTC)
            await dao.save(row)
        return await self.describe(row)

    async def versions(self, account: Account, file_id: str) -> dict[str, object]:
        items: list[dict[str, object]] = []
        current: str | None = file_id
        seen: set[str] = set()
        while current and len(items) < 100 and current not in seen:
            seen.add(current)
            row = await self._row(account, current, True)
            items.append(await self.describe(row))
            current = row.previous_file_id
        return {"items": items}
