"""模型连接、能力配置与冻结修订；即时授权与历史执行参数分开处理。"""

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from uuid import uuid4

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.models.dao.model_dao import ModelDao
from app.modules.models.entity.do.model_do import (
    ModelCapabilityDefaultRow,
    ModelConfigurationRow,
    ModelConfigurationVersionRow,
    ModelConnectionRow,
    ModelDefaultRow,
)
from app.modules.models.entity.vo.model_vo import (
    CapabilityBinding,
    CapabilityDefaultInput,
    ConfigurationInput,
    ConnectionInput,
)
from app.modules.models.service.capabilities import CAPABILITIES, validate_parameters
from app.modules.models.service.catalog_verification import verify_model_catalog
from app.modules.models.service.model_projection import project_connection
from app.modules.models.service.model_service import Audit
from app.modules.models.service.provider_transport import ProviderTransport


def connection_view(row: ModelConnectionRow) -> dict[str, object]:
    """连接公开视图只包含密钥是否存在，不回传密文。"""
    return {
        "id": row.id,
        "name": row.name,
        "adapter": row.adapter,
        "baseUrl": row.base_url,
        "region": row.region,
        "enabled": row.enabled,
        "revision": row.revision,
        "credentialConfigured": bool(row.credential),
        "scope": "platform",
    }


def configuration_view(row: ModelConfigurationRow) -> dict[str, object]:
    """能力快照保存可审查参数和角色约束。"""
    return {
        "id": row.id,
        "name": row.name,
        "kind": "chat" if row.capability == "chat" else "multimodal",
        "connectionId": row.connection_id,
        "capability": row.capability,
        "modelId": row.model_id,
        "revision": row.revision,
        "enabled": row.enabled,
        "parameters": row.parameters,
        "roleIds": row.role_ids,
    }


class ConfigurationService:
    """管理写入使用事务锁和修订比较；外部连通检测不占用数据库事务。"""

    def __init__(
        self,
        database: Database,
        cipher: CredentialCipher,
        transport: ProviderTransport,
        role_exists: Callable[[list[str]], Awaitable[bool]],
        audit: Audit | None = None,
    ) -> None:
        self.database, self.cipher, self.transport = database, cipher, transport
        self.role_exists, self.audit = role_exists, audit

    async def list(self, account: Account) -> dict[str, object]:
        """返回完整管理目录，未配置能力也有明确可用性说明。"""
        account.require("models.manage")
        async with self.database.sessions() as session:
            dao = ModelDao(session)
            return {
                "connections": [connection_view(row) for row in await dao.connections()],
                "configurations": [configuration_view(row) for row in await dao.configurations()],
                "capabilities": CAPABILITIES,
                "defaults": [
                    {
                        "capability": row.capability,
                        "configurationId": row.configuration_id,
                        "revision": row.revision,
                    }
                    for row in await dao.capability_defaults()
                ],
            }

    async def save_connection(
        self, account: Account, body: ConnectionInput, identifier: str | None = None
    ) -> dict[str, object]:
        """被配置引用的连接不能静默换适配器或地址，避免冻结配置改向其他供应商。"""
        account.require("models.manage")
        creating, identifier = identifier is None, identifier or "connection-" + uuid4().hex[:16]
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "model-configurations")
            dao = ModelDao(session)
            row = await dao.connection(identifier)
            if not creating and row is None:
                raise DomainError(404, "模型连接不存在")
            if row and body.revision != row.revision:
                raise DomainError(409, "连接已被修改，请重新加载")
            if (
                row
                and (row.adapter != body.adapter or row.base_url != body.baseUrl)
                and await dao.configurations(identifier)
            ):
                raise DomainError(409, "连接已被能力配置引用，不能改变适配器或地址")
            now = datetime.now(UTC)
            if row is None:
                row = ModelConnectionRow(id=identifier, created_at=now, revision=0)
                dao.add(row)
            key = body.apiKey.get_secret_value() if body.apiKey else ""
            if key:
                row.credential = self.cipher.seal(key, identifier)
            elif body.clearApiKey:
                row.credential = None
            row.name, row.adapter, row.base_url, row.region = (
                body.name.strip(),
                body.adapter,
                body.baseUrl,
                body.region,
            )
            row.enabled, row.updated_at, row.revision = body.enabled, now, row.revision + 1
            await session.flush()
            await project_connection(dao, row)
            result = connection_view(row)
        if self.audit:
            await self.audit(account.user_id, "models.connection.save", identifier, {})
        return result

    async def save(
        self, account: Account, body: ConfigurationInput, identifier: str | None = None
    ) -> dict[str, object]:
        """每次有效编辑追加不可变版本，拒绝无效角色和同连接重复聊天模型。"""
        account.require("models.manage")
        if len(set(body.roleIds)) != len(body.roleIds) or not await self.role_exists(body.roleIds):
            raise DomainError(422, "角色不存在或重复")
        creating, identifier = identifier is None, identifier or "configuration-" + uuid4().hex[:16]
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "model-configurations")
            dao = ModelDao(session)
            connection = await dao.connection(body.connectionId)
            if connection is None:
                raise DomainError(422, "模型连接不存在")
            parameters = validate_parameters(
                connection.adapter, body.capability, body.modelId, body.parameters
            )
            row = await dao.configuration(identifier)
            if not creating and row is None:
                raise DomainError(404, "模型配置不存在")
            if row and body.revision != row.revision:
                raise DomainError(409, "配置已被修改，请重新加载")
            if row and (
                row.connection_id != body.connectionId or row.capability != body.capability
            ):
                raise DomainError(422, "已有配置不能改变连接或能力类型")
            if body.capability == "chat" and any(
                other.id != identifier
                and other.model_id == body.modelId
                and other.capability == "chat"
                for other in await dao.configurations(body.connectionId)
            ):
                raise DomainError(409, "同一连接已存在该聊天模型")
            if row is None:
                row = ModelConfigurationRow(id=identifier, revision=0)
                dao.add(row)
            row.name, row.connection_id, row.capability, row.model_id = (
                body.name.strip(),
                body.connectionId,
                body.capability,
                body.modelId,
            )
            row.enabled, row.parameters, row.role_ids, row.revision = (
                body.enabled,
                parameters,
                body.roleIds,
                row.revision + 1,
            )
            result = configuration_view(row)
            await session.flush()
            dao.add(
                ModelConfigurationVersionRow(
                    configuration_id=identifier, revision=row.revision, definition=result
                )
            )
            await project_connection(dao, connection)
        if self.audit:
            await self.audit(
                account.user_id,
                "models.configuration.save",
                identifier,
                {"revision": result["revision"]},
            )
        return result

    async def set_default(
        self, account: Account, capability: str, body: CapabilityDefaultInput
    ) -> dict[str, object]:
        """默认能力单独做比较交换，未授权或停用配置不能成为默认。"""
        account.require("models.manage")
        if capability not in {str(item["id"]) for item in CAPABILITIES}:
            raise DomainError(422, "能力不存在")
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "model-configurations")
            dao = ModelDao(session)
            row = await dao.capability_default(capability)
            if body.revision != (row.revision if row else 0):
                raise DomainError(409, "默认配置已被修改，请重新加载")
            if body.configurationId:
                config = await dao.configuration(body.configurationId)
                if config is None or config.capability != capability or not config.enabled:
                    raise DomainError(422, "默认配置必须属于当前能力且已启用")
                connection = await dao.connection(config.connection_id)
                if connection is None or not connection.enabled:
                    raise DomainError(422, "默认配置的连接不可用")
            if row is None:
                row = ModelCapabilityDefaultRow(capability=capability, revision=0)
                dao.add(row)
            row.configuration_id, row.revision = body.configurationId, row.revision + 1
            if capability == "chat":
                default = await dao.default("global")
                selected = (
                    await dao.configuration(body.configurationId) if body.configurationId else None
                )
                if selected:
                    if default is None:
                        default = ModelDefaultRow(scope="global")
                        dao.add(default)
                    default.provider_id, default.model_id = (
                        selected.connection_id,
                        selected.model_id,
                    )
                elif default:
                    await dao.remove(default)
            return {
                "capability": capability,
                "configurationId": row.configuration_id,
                "revision": row.revision,
            }

    async def catalog(self, account: Account) -> dict[str, object]:
        """执行目录只暴露账号当前角色可用的能力配置。"""
        account.require("models.use")
        async with self.database.sessions() as session:
            dao = ModelDao(session)
            enabled = {row.id for row in await dao.connections() if row.enabled and row.credential}
            configs = [
                configuration_view(row)
                for row in await dao.configurations()
                if row.enabled
                and row.connection_id in enabled
                and (not row.role_ids or set(row.role_ids) & set(account.roles))
            ]
            identifiers = {item["id"] for item in configs}
            return {
                "capabilities": CAPABILITIES,
                "configurations": configs,
                "defaults": [
                    {
                        "capability": row.capability,
                        "configurationId": row.configuration_id,
                        "revision": row.revision,
                    }
                    for row in await dao.capability_defaults()
                    if row.configuration_id in identifiers
                ],
            }

    async def resolve(self, account: Account, binding: CapabilityBinding) -> dict[str, object]:
        """冻结修订保留参数，但禁用与撤权立即阻止历史配置继续执行。"""
        account.require("models.use")
        async with self.database.sessions() as session:
            dao = ModelDao(session)
            row = await dao.configuration(binding.configurationId)
            snapshot = await dao.configuration_version(binding.configurationId, binding.revision)
            if (
                row is None
                or snapshot is None
                or row.capability != binding.capability
                or not row.enabled
            ):
                raise DomainError(403, "模型配置已不可用")
            historical = snapshot.definition
            old_roles = historical.get("roleIds", [])
            if (
                not historical.get("enabled")
                or historical.get("capability") != binding.capability
                or (row.role_ids and not set(row.role_ids) & set(account.roles))
                or (
                    isinstance(old_roles, list)
                    and old_roles
                    and not set(old_roles) & set(account.roles)
                )
            ):
                raise DomainError(403, "当前角色不能执行此模型配置")
            connection = await dao.connection(row.connection_id)
            if connection is None or not connection.enabled or not connection.credential:
                raise DomainError(422, "模型连接未启用或未配置凭据")
            return {
                "configuration": historical,
                "connection": connection_view(connection),
                "apiKey": self.cipher.open(connection.credential, connection.id),
            }

    async def verify(self, account: Account, identifier: str) -> dict[str, object]:
        """检测连接使用只读模型目录；不会为探测自动发起收费生成。"""
        account.require("models.manage")
        async with self.database.sessions() as session:
            dao = ModelDao(session)
            config = await dao.configuration(identifier)
            connection = await dao.connection(config.connection_id) if config else None
            if connection is None:
                raise DomainError(404, "模型配置不存在")
            key = (
                self.cipher.open(connection.credential, connection.id)
                if connection.credential
                else ""
            )
            url, adapter = connection.base_url + "/models", connection.adapter
        headers = (
            {"x-api-key": key, "anthropic-version": "2023-06-01"}
            if adapter == "anthropic-messages"
            else {"Authorization": "Bearer " + key}
        )
        return (await verify_model_catalog(self.transport, url, headers)).model_dump()

    async def operation(self, account: Account, identifier: str) -> dict[str, object]:
        """操作收据仅能由所属账号读取。"""
        account.require("models.use")
        async with self.database.sessions() as session:
            row = await ModelDao(session).operation(identifier, account.user_id)
            if row is None:
                raise DomainError(404, "模型操作不存在")
            # 未发布成果的恢复凭据只留在服务端，HTTP不暴露对象路径或占位文件标识。
            result = {
                key: value
                for key, value in row.result.items()
                if key not in {"pendingArtifact", "_pendingArtifact"}
            }
            for key in ("id", "fileId"):
                if result.get(key) == row.id:
                    result.pop(key, None)
            return {
                "id": row.id,
                "state": row.state,
                "configurationId": row.configuration_id,
                "configurationRevision": row.configuration_revision,
                "requestId": row.request_id,
                "usage": row.usage,
                "result": result,
                "error": row.error,
                "updatedAt": row.updated_at.isoformat(),
            }
