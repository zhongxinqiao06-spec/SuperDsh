"""平台及个人模型用例：服务层负责授权、密钥、事务和默认值一致性。"""

import hashlib
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import cast
from uuid import uuid4

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.models.dao.model_dao import ModelDao
from app.modules.models.entity.do.model_do import (
    ModelCapabilityDefaultRow,
    ModelDefaultRow,
    ModelProviderRow,
)
from app.modules.models.entity.vo.model_vo import ProviderInput, Selection
from app.modules.models.service.catalog_verification import verify_model_catalog
from app.modules.models.service.model_projection import synchronize_provider
from app.modules.models.service.provider_transport import ProviderTransport

Audit = Callable[[str, str, str, dict[str, object]], Awaitable[None]]


def provider_view(row: ModelProviderRow) -> dict[str, object]:
    """输出供应商元数据，密钥只暴露是否配置。"""
    return {
        "providerId": row.id,
        "name": row.name,
        "protocol": row.protocol,
        "baseUrl": row.base_url,
        "models": row.models,
        "enabled": row.enabled,
        "apiKeyConfigured": bool(row.credential),
        "createdAt": row.created_at.isoformat(),
        "updatedAt": row.updated_at.isoformat(),
        "source": "personal" if row.owner_id else "platform",
    }


class ModelService:
    """个人模型的管理权限不等于平台模型管理，也不授予读取他人密钥。"""

    def __init__(
        self,
        database: Database,
        cipher: CredentialCipher,
        allowed_origins: str = "",
        audit: Audit | None = None,
        transport: ProviderTransport | None = None,
    ) -> None:
        self.database, self.cipher, self.audit = database, cipher, audit
        self.transport = transport or ProviderTransport(allowed_origins)

    async def record(
        self, actor: str, action: str, target: str, detail: dict[str, object] | None = None
    ) -> None:
        """审计只记录资源标识和操作结果，不记录请求中的凭据。"""
        if self.audit:
            await self.audit(actor, action, target, detail or {})

    @staticmethod
    def owner(account: Account, personal: bool) -> str | None:
        account.require("models.personal.manage" if personal else "models.manage")
        return account.user_id if personal else None

    async def providers(self, account: Account, personal: bool = False) -> list[dict[str, object]]:
        """列出当前管理作用域，不混合其他账号个人连接。"""
        owner = self.owner(account, personal)
        async with self.database.sessions() as session:
            return [provider_view(row) for row in await ModelDao(session).providers(owner)]

    async def save_provider(
        self,
        account: Account,
        body: ProviderInput,
        identifier: str | None = None,
        personal: bool = False,
    ) -> dict[str, object]:
        """未编辑密钥时保留旧值，默认模型的停用或移除必须先改变默认选择。"""
        owner = self.owner(account, personal)
        creating = identifier is None
        identifier = identifier or ("personal-" if personal else "platform-") + uuid4().hex[:16]
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "model-configurations")
            dao = ModelDao(session)
            row = await dao.provider(identifier)
            if not creating and (row is None or row.owner_id != owner):
                raise DomainError(404, "供应商不存在")
            if any(
                not body.enabled
                or selected.model_id not in {model.modelId for model in body.models}
                for selected in await dao.selected_defaults(identifier)
            ):
                raise DomainError(422, "请先修改默认模型，再停用或删除已选模型")
            now = datetime.now(UTC)
            if row is None:
                row = ModelProviderRow(id=identifier, owner_id=owner, created_at=now)
                dao.add(row)
            key = body.apiKey.get_secret_value() if body.apiKey else ""
            if key:
                row.credential = self.cipher.seal(key, identifier)
            elif body.clearApiKey:
                row.credential = None
            row.name, row.protocol, row.base_url = body.name.strip(), body.protocol, body.baseUrl
            row.models = [item.model_dump(exclude_none=True) for item in body.models]
            row.enabled, row.updated_at = body.enabled, now
            await session.flush()
            await synchronize_provider(dao, row)
            result = provider_view(row)
        await self.record(account.user_id, "models.provider.save", identifier)
        return result

    async def remove_provider(
        self, account: Account, identifier: str, personal: bool = False
    ) -> None:
        """删除供应商与对应默认值原子提交。"""
        owner = self.owner(account, personal)
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "model-configurations")
            dao = ModelDao(session)
            row = await dao.provider(identifier)
            if row is None or row.owner_id != owner:
                raise DomainError(404, "供应商不存在")
            await dao.delete_defaults(identifier)
            connection = await dao.connection(identifier)
            if connection:
                connection.enabled, connection.revision = False, connection.revision + 1
                selected_capability = await dao.capability_default("chat")
                selected_configuration = (
                    await dao.configuration(selected_capability.configuration_id)
                    if selected_capability and selected_capability.configuration_id
                    else None
                )
                if (
                    selected_capability
                    and selected_configuration
                    and selected_configuration.connection_id == identifier
                ):
                    selected_capability.configuration_id = None
                    selected_capability.revision += 1
            await dao.remove(row)
        await self.record(account.user_id, "models.provider.delete", identifier)

    async def default(self, account: Account, personal: bool = False) -> dict[str, object] | None:
        """读取当前作用域的显式默认值，不自动保存推测结果。"""
        owner = self.owner(account, personal)
        async with self.database.sessions() as session:
            row = await ModelDao(session).default("user:" + owner if owner else "global")
            return {"providerId": row.provider_id, "modelId": row.model_id} if row else None

    async def set_default(
        self, account: Account, selected: Selection | None, personal: bool = False
    ) -> dict[str, object] | None:
        """仅可选择同作用域已启用模型，空值清除默认。"""
        owner = self.owner(account, personal)
        scope = "user:" + owner if owner else "global"
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "model-configurations")
            dao = ModelDao(session)
            if selected:
                provider = await dao.provider(selected.providerId)
                if (
                    provider is None
                    or provider.owner_id != owner
                    or not provider.enabled
                    or not any(model["modelId"] == selected.modelId for model in provider.models)
                ):
                    raise DomainError(422, "默认选择必须为已启用的模型")
            row = await dao.default(scope)
            if selected:
                if row is None:
                    row = ModelDefaultRow(scope=scope)
                    dao.add(row)
                row.provider_id, row.model_id = selected.providerId, selected.modelId
            elif row:
                await dao.remove(row)
            if not personal:
                capability = await dao.capability_default("chat")
                if capability is None:
                    capability = ModelCapabilityDefaultRow(capability="chat", revision=0)
                    dao.add(capability)
                options = await dao.configurations(selected.providerId) if selected else []
                chosen = next(
                    (
                        item
                        for item in options
                        if item.capability == "chat"
                        and selected
                        and item.model_id == selected.modelId
                    ),
                    None,
                )
                capability.configuration_id, capability.revision = (
                    chosen.id if chosen else None,
                    capability.revision + 1,
                )
        await self.record(account.user_id, "models.default.save", scope)
        return selected.model_dump() if selected else None

    async def catalog(self, account: Account) -> dict[str, object]:
        """执行目录只包含当前用户个人与平台的启用模型，永远不含凭据和内网地址。"""
        account.require("models.use")
        async with self.database.sessions() as session:
            dao = ModelDao(session)
            rows = await dao.providers(account.user_id) + await dao.providers(None)
            visible_rows: list[dict[str, object]] = []
            for provider in rows:
                if not provider.enabled:
                    continue
                configurations = (
                    await dao.configurations(provider.id) if provider.owner_id is None else []
                )
                permitted = {
                    item.model_id
                    for item in configurations
                    if item.enabled
                    and (not item.role_ids or set(item.role_ids) & set(account.roles))
                }
                # 固定 DSH 以字段缺失表示未配置；null 会被误认作显式 token 上限。
                # 同时兼容数据库里早先保存的 null，只修输出，不覆盖用户参数或猜测数值。
                models = [
                    {key: value for key, value in item.items() if value is not None}
                    for item in provider.models
                    if not configurations or item["modelId"] in permitted
                ]
                if models:
                    visible_rows.append(
                        {
                            "providerId": provider.id,
                            "name": provider.name,
                            "protocol": provider.protocol,
                            "models": models,
                            "source": "personal" if provider.owner_id else "platform",
                        }
                    )
            selections = []
            for scope in ("user:" + account.user_id, "global"):
                row = await dao.default(scope)
                selections.append(
                    {"providerId": row.provider_id, "modelId": row.model_id} if row else None
                )
            visible = {
                (item["providerId"], model["modelId"])
                for item in visible_rows
                for model in cast(list[dict[str, object]], item["models"])
            }
            selections = [
                selection
                if selection and (selection["providerId"], selection["modelId"]) in visible
                else None
                for selection in selections
            ]
            return {
                "scope": hashlib.sha256(("user:" + account.user_id).encode()).hexdigest(),
                "providers": visible_rows,
                "default": selections[0] or selections[1],
                "personalDefault": selections[0],
                "platformDefault": selections[1],
                "serverTime": datetime.now(UTC).isoformat(),
            }

    async def resolve(
        self, account: Account, provider_id: str, protocol: str, model_id: str
    ) -> dict[str, object]:
        """仅受信执行适配读取明文，调用时重新核对供应商状态和资源归属。"""
        account.require("models.use")
        async with self.database.sessions() as session:
            row = await ModelDao(session).provider(provider_id)
            if (
                row is None
                or row.owner_id not in {None, account.user_id}
                or not row.enabled
                or row.protocol != protocol
            ):
                raise DomainError(404, "模型供应商不可用")
            if not any(model["modelId"] == model_id for model in row.models):
                raise DomainError(422, "请求的模型不可用")
            connection = (
                await ModelDao(session).connection(row.id) if row.owner_id is None else None
            )
            if connection and not connection.enabled:
                raise DomainError(403, "模型连接已停用")
            if row.owner_id is None:
                configs = [
                    item
                    for item in await ModelDao(session).configurations(row.id)
                    if item.capability == "chat" and item.model_id == model_id
                ]
                if (connection is not None or configs) and not any(
                    item.enabled and (not item.role_ids or set(item.role_ids) & set(account.roles))
                    for item in configs
                ):
                    raise DomainError(403, "当前角色不能使用此聊天模型")
            return {
                "baseUrl": row.base_url,
                "key": self.cipher.open(row.credential, row.id) if row.credential else None,
                "personal": bool(row.owner_id),
                "forceNoStore": bool(connection and connection.adapter == "volcengine-ark"),
            }

    async def verify_provider(
        self, account: Account, identifier: str, personal: bool = False
    ) -> dict[str, object]:
        """连接检测只请求供应商模型目录，有超时且不产生模型生成费用。"""
        owner = self.owner(account, personal)
        async with self.database.sessions() as session:
            row = await ModelDao(session).provider(identifier)
            if row is None or row.owner_id != owner:
                raise DomainError(404, "供应商不存在")
            key = self.cipher.open(row.credential, row.id) if row.credential else ""
            headers = {"Accept": "application/json"}
            if row.protocol == "anthropic-messages":
                headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
            elif key:
                headers["Authorization"] = "Bearer " + key
            url = row.base_url + "/models"
        return (await verify_model_catalog(self.transport, url, headers)).model_dump()
