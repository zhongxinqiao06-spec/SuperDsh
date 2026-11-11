"""模型管理协议适配；授权、凭据和持久化均由领域服务负责。"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.api.dependencies import current_account
from app.modules.identity.entity.bo.models import Account
from app.modules.models.entity.vo.model_vo import (
    CapabilityDefaultInput,
    ConfigurationInput,
    ConnectionInput,
    DefaultInput,
    ProviderInput,
)
from app.modules.models.service.configuration_service import ConfigurationService
from app.modules.models.service.model_service import ModelService

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> ModelService:
    """从应用装配取供应商用例，不在控制器创建客户端。"""
    return request.app.state.services.models


def configurations(request: Request) -> ConfigurationService:
    """能力配置与供应商共享加密和外部连接策略。"""
    return request.app.state.services.model_configurations


def provider_routes(prefix: str, personal: bool) -> APIRouter:
    """平台与个人目录使用相同 DTO，权限及归属参数由入口固定。"""
    child = APIRouter(prefix=prefix)

    @child.get("/providers")
    async def list_providers(request: Request, account: AccountDep) -> dict[str, object]:
        return {
            "providers": await service(request).providers(account, personal),
            "serverTime": datetime.now(UTC).isoformat(),
        }

    @child.post("/providers")
    async def create_provider(
        body: ProviderInput, request: Request, account: AccountDep
    ) -> dict[str, object]:
        return await service(request).save_provider(account, body, personal=personal)

    @child.patch("/providers/{provider_id}")
    async def update_provider(
        provider_id: str, body: ProviderInput, request: Request, account: AccountDep
    ) -> dict[str, object]:
        return await service(request).save_provider(account, body, provider_id, personal)

    @child.delete("/providers/{provider_id}")
    async def delete_provider(
        provider_id: str, request: Request, account: AccountDep
    ) -> dict[str, object]:
        await service(request).remove_provider(account, provider_id, personal)
        return {"deleted": True, "serverTime": datetime.now(UTC).isoformat()}

    @child.get("/default")
    async def read_default(request: Request, account: AccountDep) -> dict[str, object]:
        return {
            "selection": await service(request).default(account, personal),
            "serverTime": datetime.now(UTC).isoformat(),
        }

    @child.put("/default")
    async def save_default(
        body: DefaultInput, request: Request, account: AccountDep
    ) -> dict[str, object]:
        return {
            "selection": await service(request).set_default(account, body.selection, personal),
            "serverTime": datetime.now(UTC).isoformat(),
        }

    @child.post("/providers/{provider_id}/verify")
    @child.post("/providers/{provider_id}/validate")
    async def verify(provider_id: str, request: Request, account: AccountDep) -> dict[str, object]:
        return await service(request).verify_provider(account, provider_id, personal)

    return child


router.include_router(provider_routes("/admin/models", False))
router.include_router(provider_routes("/models/personal", True))


@router.get("/models/catalog")
async def catalog(request: Request, account: AccountDep) -> dict[str, object]:
    """为工作台返回当前账号可执行模型。"""
    return await service(request).catalog(account)


@router.get("/admin/models/configurations")
async def configuration_list(request: Request, account: AccountDep) -> dict[str, object]:
    """管理页一次加载连接、模型配置和能力默认值。"""
    return await configurations(request).list(account)


@router.post("/admin/models/connections")
async def connection_create(
    body: ConnectionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """创建一个可复用的供应商连接。"""
    return await configurations(request).save_connection(account, body)


@router.patch("/admin/models/connections/{identifier}")
async def connection_update(
    identifier: str, body: ConnectionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """按修订更新连接，密钥为空时保留。"""
    return await configurations(request).save_connection(account, body, identifier)


@router.post("/admin/models/configurations")
async def configuration_create(
    body: ConfigurationInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """创建能力配置并保存首个不可变修订。"""
    return await configurations(request).save(account, body)


@router.patch("/admin/models/configurations/{identifier}")
async def configuration_update(
    identifier: str, body: ConfigurationInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """配置编辑需要客户端提供当前修订。"""
    return await configurations(request).save(account, body, identifier)


@router.put("/admin/models/defaults/{capability}")
async def capability_default(
    capability: str, body: CapabilityDefaultInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """保存能力默认并返回管理页默认值列表。"""
    await configurations(request).set_default(account, capability, body)
    return {"defaults": (await configurations(request).list(account))["defaults"]}


@router.post("/admin/models/configurations/{identifier}/verify")
async def configuration_verify(
    identifier: str, request: Request, account: AccountDep
) -> dict[str, object]:
    """使用有界请求验证供应商连接。"""
    return await configurations(request).verify(account, identifier)


@router.get("/models/capabilities")
async def capabilities(request: Request, account: AccountDep) -> dict[str, object]:
    """仅返回用户当前角色可执行的能力。"""
    return await configurations(request).catalog(account)


@router.get("/models/operations/{identifier}")
async def operation(identifier: str, request: Request, account: AccountDep) -> dict[str, object]:
    """读取收费操作持久收据，不替用户自动重发。"""
    return await configurations(request).operation(account, identifier)
