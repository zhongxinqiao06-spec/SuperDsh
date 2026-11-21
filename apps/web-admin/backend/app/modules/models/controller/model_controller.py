"""模型管理协议适配；授权、凭据和持久化均由领域服务负责。"""

from datetime import UTC, datetime
from ipaddress import ip_address
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import SecretStr

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.product_roles import Product
from app.modules.models.entity.vo.model_vo import (
    CapabilityDefaultInput,
    ConfigurationInput,
    ConnectionInput,
    DefaultInput,
    KeyConfirmation,
    ProductDefaultInput,
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


def require_key_transport(request: Request) -> None:
    """公网入口覆盖转发协议，明文凭据仅允许 HTTPS 或本机回环直连。"""
    forwarded = request.headers.get("x-forwarded-proto")
    if request.url.scheme == "https":
        return
    if forwarded == "https" and request.client:
        try:
            if ip_address(request.client.host).is_private:
                return
        except ValueError:
            pass
    if (
        not forwarded
        and request.client
        and request.client.host in {"::1", "127.0.0.1"}
        and request.url.hostname in {"::1", "localhost", "127.0.0.1"}
    ):
        return
    raise DomainError(403, "管理 API Key 请使用 HTTPS 或本机安全隧道")


async def confirm_key(
    request: Request, account: Account, proof: SecretStr | None, target: str
) -> None:
    require_key_transport(request)
    await request.app.state.services.identity.confirm_model_key(
        account, proof.get_secret_value() if proof else "", target
    )


@router.get("/admin/products/{product}/model-defaults")
async def product_defaults(
    product: Product, request: Request, account: AccountDep
) -> dict[str, object]:
    """产品模型目录不包含供应商地址和密钥。"""
    return await configurations(request).product_settings(account, product)


@router.put("/admin/products/{product}/model-defaults/{capability}")
async def set_product_default(
    product: Product,
    capability: str,
    body: ProductDefaultInput,
    request: Request,
    account: AccountDep,
) -> dict[str, object]:
    return await configurations(request).set_product_default(
        account, product, capability, body.configurationId
    )


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
        if not personal and body.apiKey:
            require_key_transport(request)
        return await service(request).save_provider(account, body, personal=personal)

    @child.patch("/providers/{provider_id}")
    async def update_provider(
        provider_id: str, body: ProviderInput, request: Request, account: AccountDep
    ) -> dict[str, object]:
        if not personal and (body.apiKey or body.clearApiKey):
            await confirm_key(request, account, body.passwordVerifier, provider_id)
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
async def catalog(
    request: Request, account: AccountDep, product: Product | None = None
) -> dict[str, object]:
    """为工作台返回当前账号可执行模型。"""
    return await service(request).catalog(account, product)


@router.get("/admin/models/configurations")
async def configuration_list(request: Request, account: AccountDep) -> dict[str, object]:
    """管理页一次加载连接、模型配置和能力默认值。"""
    return await configurations(request).list(account)


@router.post("/admin/models/connections")
async def connection_create(
    body: ConnectionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """创建一个可复用的供应商连接。"""
    if body.apiKey:
        require_key_transport(request)
    return await configurations(request).save_connection(account, body)


@router.patch("/admin/models/connections/{identifier}")
async def connection_update(
    identifier: str, body: ConnectionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """按修订更新连接，密钥为空时保留。"""
    if body.apiKey or body.clearApiKey:
        await confirm_key(request, account, body.passwordVerifier, identifier)
    return await configurations(request).save_connection(account, body, identifier)


@router.post("/admin/models/connections/{identifier}/reveal-key")
async def reveal_connection_key(
    identifier: str,
    body: KeyConfirmation,
    request: Request,
    response: Response,
    account: AccountDep,
) -> dict[str, str]:
    """仅向刚复核密码的管理员返回此连接密钥，禁止浏览器与代理缓存。"""
    await confirm_key(request, account, body.passwordVerifier, identifier)
    response.headers["Cache-Control"] = "no-store, private"
    return {"apiKey": await configurations(request).reveal_key(account, identifier)}


@router.post("/admin/models/connections/{identifier}/inspect")
async def inspect_connection(
    identifier: str, request: Request, account: AccountDep
) -> dict[str, object]:
    """只读查询供应商公布的目录及余额，不调用生成接口。"""
    return await configurations(request).inspect_connection(account, identifier)


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
async def capabilities(
    request: Request, account: AccountDep, product: Product | None = None
) -> dict[str, object]:
    """仅返回用户当前角色可执行的能力。"""
    return await configurations(request).catalog(account, product)


@router.get("/models/operations/{identifier}")
async def operation(identifier: str, request: Request, account: AccountDep) -> dict[str, object]:
    """读取收费操作持久收据，不替用户自动重发。"""
    return await configurations(request).operation(account, identifier)
