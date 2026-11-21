"""模型连接、能力配置与冻结修订；即时授权与历史执行参数分开处理。"""

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from uuid import uuid4

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.product_roles import Product
from app.modules.models.dao.model_dao import ModelDao
from app.modules.models.entity.do.model_do import (
    ModelCapabilityDefaultRow,
    ModelConfigurationRow,
    ModelConfigurationVersionRow,
    ModelConnectionRow,
    ModelDefaultRow,
    ProductModelDefaultRow,
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
from app.modules.models.service.model_service import Audit, ProductRoles
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.models.service.supplier_inspection import inspect_supplier


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
        "subscription": row.subscription or {},
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
        *,
        product_roles: ProductRoles,
    ) -> None:
        self.database, self.cipher, self.transport = database, cipher, transport
        self.role_exists, self.audit, self.product_roles = role_exists, audit, product_roles

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

    async def reveal_key(self, account: Account, identifier: str) -> str:
        """路由已逐次复核密码；普通目录接口永不解密。"""
        account.require("models.manage")
        if "admin" not in account.roles:
            raise DomainError(403, "需要平台管理员权限")
        async with self.database.sessions() as session:
            row = await ModelDao(session).connection(identifier)
            if not row or not row.credential:
                raise DomainError(404, "此连接没有已保存的密钥")
            key = self.cipher.open(row.credential, row.id)
        if self.audit:
            await self.audit(account.user_id, "models.key.reveal", identifier, {})
        return key

    async def inspect_connection(self, account: Account, identifier: str) -> dict[str, object]:
        """不持有数据库连接等待外部模型服务。"""
        account.require("models.manage")
        async with self.database.sessions() as session:
            row = await ModelDao(session).connection(identifier)
            if not row:
                raise DomainError(404, "模型连接不存在")
            url, adapter = row.base_url, row.adapter
            key = self.cipher.open(row.credential, row.id) if row.credential else ""
        return await inspect_supplier(self.transport, url, adapter, key)

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
            if row.credential and row.base_url != body.baseUrl and not (key or body.clearApiKey):
                raise DomainError(409, "更换 API 地址时请重新输入或清除密钥")
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
            row.admin_managed = True
            if body.subscription is not None:
                row.subscription = body.subscription.model_dump()
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
                connection.adapter,
                body.capability,
                body.modelId,
                body.parameters,
                connection.base_url,
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
            row.admin_managed = True
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

    async def _catalog(
        self, dao: ModelDao, account: Account, product: Product | None, management: bool = False
    ) -> dict[str, object]:
        """所有选择和运行时冻结均从相同的、已过滤角色与连接状态的目录读取。"""
        roles = set(await self.product_roles(account, product)) if product else set(account.roles)
        enabled = {row.id for row in await dao.connections() if row.enabled and row.credential}
        configs = [
            configuration_view(row)
            for row in await dao.configurations()
            if row.enabled
            and row.connection_id in enabled
            and (not row.role_ids or set(row.role_ids) & roles)
        ]
        identifiers = {item["id"] for item in configs}
        defaults = {
            row.capability: {
                "capability": row.capability,
                "configurationId": row.configuration_id,
                "revision": row.revision,
            }
            for row in await dao.capability_defaults()
            if row.configuration_id in identifiers
        }
        overrides = {}
        if product:
            for row in await dao.product_defaults(product):
                # 覆盖项失效后显式取消本能力选择，不能静默切换到另一供应商。
                defaults.pop(row.capability, None)
                if row.configuration_id in identifiers:
                    defaults[row.capability] = {
                        "capability": row.capability,
                        "configurationId": row.configuration_id,
                    }
                    overrides[row.capability] = row.configuration_id
        result: dict[str, object] = {
            "capabilities": CAPABILITIES,
            "configurations": configs,
            "defaults": list(defaults.values()),
        }
        if management:
            result["overrides"] = overrides
        return result

    async def catalog(self, account: Account, product: Product | None = None) -> dict[str, object]:
        """执行目录只暴露账号在该产品当前可用的配置。"""
        account.require("models.use")
        if product is not None:
            account.require("products." + product)
        async with self.database.sessions() as session:
            return await self._catalog(ModelDao(session), account, product)

    @staticmethod
    def require_product_models(account: Account, product: Product) -> None:
        """原有平台模型管理员保留有权进入产品的设置能力。"""
        if "models.manage" in account.permissions:
            account.require("models.manage")
            account.require("products." + product)
        else:
            account.require_product_management(product, "models")

    async def product_settings(self, account: Account, product: Product) -> dict[str, object]:
        self.require_product_models(account, product)
        async with self.database.sessions() as session:
            return await self._catalog(ModelDao(session), account, product, management=True)

    async def set_product_default(
        self, account: Account, product: Product, capability: str, value: str | None
    ) -> dict[str, object]:
        """只在已授权的模型目录选择默认配置；与平台连接和配置变更共用同一事务锁。"""
        self.require_product_models(account, product)
        if capability not in {str(item["id"]) for item in CAPABILITIES}:
            raise DomainError(422, "能力不存在")
        async with self.database.sessions.begin() as session:
            await lock_transaction(session, "model-configurations")
            dao = ModelDao(session)
            if value:
                roles = set(await self.product_roles(account, product))
                config = await dao.configuration(value)
                connection = await dao.connection(config.connection_id) if config else None
                if (
                    not config
                    or not config.enabled
                    or config.capability != capability
                    or (config.role_ids and not set(config.role_ids) & roles)
                    or not connection
                    or not connection.enabled
                    or not connection.credential
                ):
                    raise DomainError(422, "请选择此能力下已授权且可用的模型配置")
            previous = await dao.product_default(product, capability)
            if previous is not None and value is None:
                await dao.remove(previous)
            elif previous is not None and value:
                previous.configuration_id = value
            elif value:
                dao.add(
                    ProductModelDefaultRow(
                        product=product, capability=capability, configuration_id=value
                    )
                )
        if self.audit:
            await self.audit(
                account.user_id,
                "products.model-default.save",
                product,
                {"capability": capability, "configurationId": value},
            )
        return {"capability": capability, "configurationId": value}

    async def resolve(
        self, account: Account, binding: CapabilityBinding, product: Product = "office"
    ) -> dict[str, object]:
        """冻结修订保留参数，但禁用与撤权立即阻止历史配置继续执行。"""
        account.require("models.use")
        account.require("products." + product)
        roles = set(await self.product_roles(account, product))
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
                or (row.role_ids and not set(row.role_ids) & roles)
                or (isinstance(old_roles, list) and old_roles and not set(old_roles) & roles)
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
