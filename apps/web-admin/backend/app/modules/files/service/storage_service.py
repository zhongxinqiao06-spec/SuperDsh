"""存储配置用例：凭据遮罩、乐观并发与连接诊断。"""

import json
from pathlib import Path
from uuid import uuid4

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.errors import DomainError
from app.modules.files.dao.file_dao import FileRepository
from app.modules.files.entity.do.models import StorageConnectionRow, StorageSettingsRow
from app.modules.files.entity.vo.file_dto import ConnectionInput, SettingsInput, StoragePolicy
from app.modules.files.service.object_storage import ObjectStorage
from app.modules.identity.entity.bo.models import Account


class StorageService:
    """持久配置不随重启覆盖，改密为空时保留旧密钥。"""

    def __init__(self, repository: FileRepository, root: Path, cipher: CredentialCipher) -> None:
        self.repository, self.root, self.cipher = repository, root, cipher

    async def initialize(self) -> None:
        """仅创建缺失的本地连接和初始策略，不重置已有配置。"""
        async with self.repository.transaction() as dao:
            await dao.lock("settings")
            if not await dao.connection("local"):
                await dao.save(
                    StorageConnectionRow(
                        id="local",
                        name="环境存储",
                        configuration={"backend": "local"},
                        credentials=None,
                        enabled=True,
                        revision=1,
                    )
                )
            if not await dao.settings():
                await dao.save(
                    StorageSettingsRow(
                        id="global",
                        active_connection_id="local",
                        policy=StoragePolicy().model_dump(),
                        revision=1,
                    )
                )

    async def policy(self) -> dict[str, object]:
        await self.initialize()
        async with self.repository.transaction() as dao:
            row = await dao.settings()
            assert row is not None
            return {
                "activeConnectionId": row.active_connection_id,
                "policy": row.policy,
                "revision": row.revision,
            }

    async def settings(self, account: Account) -> dict[str, object]:
        """仅管理权限可见连接配置，绝不返回凭据密文或明文。"""
        account.require("storage.manage")
        state = await self.policy()
        async with self.repository.transaction() as dao:
            state["connections"] = [self._view(row) for row in await dao.connections()]
        return state

    def _view(self, row: StorageConnectionRow) -> dict[str, object]:
        """管理员配置视图补齐本地目录和通用字段，目录来自实际对象存储根。"""
        configuration = dict(row.configuration)
        if configuration.get("backend") == "local":
            configuration = {
                "root": str((self.root / "objects").resolve()),
                "region": "us-east-1",
                "virtualHostStyle": False,
                **configuration,
            }
        return {
            "id": row.id,
            "name": row.name,
            "backend": row.configuration["backend"],
            "configuration": configuration,
            "credentialConfigured": bool(row.credentials),
            "revision": row.revision,
            "enabled": row.enabled,
        }

    async def get(self, identifier: str, writing: bool = False) -> ObjectStorage:
        """返回内部对象适配器；此方法只供已授权的文件服务调用。"""
        await self.initialize()
        async with self.repository.transaction() as dao:
            row = await dao.connection(identifier)
            if not row or writing and not row.enabled:
                raise DomainError(503, "文件存储不存在或已停用")
            credentials = (
                json.loads(self.cipher.open(row.credentials, row.id)) if row.credentials else {}
            )
            return ObjectStorage(row.configuration, credentials, self.root / "objects")

    async def save(
        self, account: Account, body: ConnectionInput, identifier: str | None = None
    ) -> dict[str, object]:
        account.require("storage.manage")
        await self.initialize()
        # 结构校验与签名器使用同一配置；错误只返回检查项，不携带凭据。
        from urllib.parse import urlsplit

        address = urlsplit(body.configuration.endpoint)
        if (
            address.scheme not in {"http", "https"}
            or not address.netloc
            or address.username
            or address.password
            or address.query
            or address.fragment
            or ".." in body.configuration.prefix.split("/")
        ):
            raise DomainError(422, "S3 地址或对象前缀无效")
        async with self.repository.transaction() as dao:
            await dao.lock("settings")
            row = await dao.connection(identifier) if identifier else None
            if identifier and not row:
                raise DomainError(404, "存储连接不存在")
            if row and (identifier == "local" or body.revision != row.revision):
                raise DomainError(409, "存储连接已更新或受保护，请重新加载")
            if not row:
                row = StorageConnectionRow(id="storage_" + uuid4().hex, revision=0)
            if body.credentials:
                row.credentials = self.cipher.seal(body.credentials.model_dump_json(), row.id)
            elif not row.credentials:
                raise DomainError(422, "请配置存储凭据")
            row.name, row.configuration, row.enabled = (
                body.name,
                body.configuration.model_dump(),
                body.enabled,
            )
            row.revision += 1
            await dao.save(row)
            return self._view(row)

    async def update(self, account: Account, body: SettingsInput) -> dict[str, object]:
        account.require("storage.manage")
        await self.initialize()
        async with self.repository.transaction() as dao:
            await dao.lock("settings")
            row, connection = await dao.settings(), await dao.connection(body.activeConnectionId)
            if not row or body.revision != row.revision:
                raise DomainError(409, "存储设置已更新，请重新加载")
            if not connection or not connection.enabled:
                raise DomainError(422, "请选择已启用的存储连接")
            row.active_connection_id, row.policy = body.activeConnectionId, body.policy.model_dump()
            row.revision += 1
            await dao.save(row)
        return await self.settings(account)

    async def check(self, account: Account, identifier: str) -> dict[str, object]:
        account.require("storage.manage")
        await (await self.get(identifier)).check()
        return {"ok": True}
