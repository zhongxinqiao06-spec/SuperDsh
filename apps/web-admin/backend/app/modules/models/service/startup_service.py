"""将受信任后端配置同步为平台默认模型；不依赖登录、不启动模型调用。"""

import asyncio
import hmac
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import Database, lock_transaction
from app.modules.models.dao.model_dao import ModelDao
from app.modules.models.entity.do.model_do import (
    ModelCapabilityDefaultRow,
    ModelConfigurationRow,
    ModelConfigurationVersionRow,
    ModelConnectionRow,
    ModelDefaultRow,
)
from app.modules.models.entity.vo.startup_vo import (
    StartupConfiguration,
    StartupConnection,
    StartupModels,
)
from app.modules.models.service.capabilities import validate_parameters
from app.modules.models.service.model_projection import project_connection, snapshot
from app.modules.models.service.startup_configuration import load_startup_models


class StartupModelService:
    """同一模型事务锁内原子同步；重复启动不制造修订或重复记录。"""

    def __init__(
        self,
        database: Database,
        cipher: CredentialCipher,
        role_exists: Callable[[list[str]], Awaitable[bool]],
    ) -> None:
        self.database, self.cipher, self.role_exists = database, cipher, role_exists

    async def initialize(self, path: Path | None) -> None:
        """仅显式指定文件时启用；读取错误直接阻止启动，不回退旧平台。"""
        if path is not None:
            await self.synchronize(await asyncio.to_thread(load_startup_models, path))

    async def synchronize(self, configuration: StartupModels) -> None:
        """文件内记录以配置为准；未声明的个人/平台记录及冻结历史保持原状。"""
        roles = sorted({role for item in configuration.configurations for role in item.roleIds})
        if roles and not await self.role_exists(roles):
            raise RuntimeError("模型启动配置引用了不存在的角色")
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "model-configurations")
            dao = ModelDao(session)
            connections: dict[str, ModelConnectionRow] = {}
            changed: set[str] = set()
            for connection_body in configuration.connections:
                row, modified = await self._connection(dao, connection_body)
                connections[connection_body.id] = row
                if modified:
                    changed.add(connection_body.id)
            await session.flush()
            for model_body in configuration.configurations:
                if await self._configuration(dao, model_body, connections[model_body.connectionId]):
                    changed.add(model_body.connectionId)
            await session.flush()
            for identifier in changed:
                await project_connection(dao, connections[identifier])
            await session.flush()
            for capability, default_identifier in configuration.defaults.items():
                await self._default(dao, capability, default_identifier)

    async def _connection(
        self, dao: ModelDao, body: StartupConnection
    ) -> tuple[ModelConnectionRow, bool]:
        provider = await dao.provider(body.id)
        if provider is not None and provider.owner_id is not None:
            raise RuntimeError("启动连接标识与个人供应商冲突，拒绝接管")
        row = await dao.connection(body.id)
        if (
            row is not None
            and (row.adapter != body.adapter or row.base_url != body.baseUrl)
            and await dao.configurations(body.id)
        ):
            raise RuntimeError("启动连接已被模型配置引用，不能更改适配器或地址；请使用新连接标识")
        values = {
            "name": body.name,
            "adapter": body.adapter,
            "base_url": body.baseUrl,
            "region": body.region,
            "enabled": body.enabled,
        }
        key = body.apiKey.get_secret_value() if body.apiKey else ""
        key_changed = bool(key) and (
            row is None
            or not row.credential
            or not hmac.compare_digest(
                self.cipher.open(row.credential, body.id).encode(), key.encode()
            )
        )
        clear_key = bool(body.clearApiKey and row is not None and row.credential)
        modified = (
            row is None
            or any(getattr(row, field) != value for field, value in values.items())
            or key_changed
            or clear_key
        )
        now = datetime.now(UTC)
        if row is None:
            row = ModelConnectionRow(id=body.id, revision=0, created_at=now)
            dao.add(row)
        if modified:
            for field, value in values.items():
                setattr(row, field, value)
            if key_changed:
                row.credential = self.cipher.seal(key, body.id)
            elif body.clearApiKey:
                row.credential = None
            row.updated_at, row.revision = now, row.revision + 1
        return row, modified

    async def _configuration(
        self, dao: ModelDao, body: StartupConfiguration, connection: ModelConnectionRow
    ) -> bool:
        parameters = validate_parameters(
            connection.adapter, body.capability, body.modelId, body.parameters
        )
        row = await dao.configuration(body.id)
        if row is not None and (
            row.connection_id != body.connectionId or row.capability != body.capability
        ):
            raise RuntimeError("已有启动模型配置不能改变连接或能力类型；请使用新配置标识")
        if body.capability == "chat" and any(
            other.id != body.id and other.capability == "chat" and other.model_id == body.modelId
            for other in await dao.configurations(body.connectionId)
        ):
            raise RuntimeError("启动配置与已有聊天模型重复；请复用原配置标识")
        values = {
            "name": body.name,
            "connection_id": body.connectionId,
            "capability": body.capability,
            "model_id": body.modelId,
            "enabled": body.enabled,
            "parameters": parameters,
            "role_ids": body.roleIds,
        }
        if row is not None and all(getattr(row, field) == value for field, value in values.items()):
            return False
        if row is None:
            row = ModelConfigurationRow(id=body.id, revision=0)
            dao.add(row)
        for field, value in values.items():
            setattr(row, field, value)
        row.revision += 1
        await dao.session.flush()
        dao.add(
            ModelConfigurationVersionRow(
                configuration_id=row.id, revision=row.revision, definition=snapshot(row)
            )
        )
        return True

    async def _default(self, dao: ModelDao, capability: str, identifier: str | None) -> None:
        row = await dao.capability_default(capability)
        if row is None:
            row = ModelCapabilityDefaultRow(capability=capability, revision=0)
            dao.add(row)
        if row.configuration_id != identifier:
            row.configuration_id, row.revision = identifier, row.revision + 1
        if capability != "chat":
            return
        selected = await dao.configuration(identifier) if identifier else None
        default = await dao.default("global")
        if selected is not None:
            if default is None:
                default = ModelDefaultRow(scope="global")
                dao.add(default)
            default.provider_id, default.model_id = selected.connection_id, selected.model_id
        elif default is not None:
            await dao.remove(default)
