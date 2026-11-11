"""浏览器及Connector模型代理，仅协议白名单进入模型服务。"""

from collections.abc import AsyncIterator
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse, StreamingResponse

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.models.service.proxy_service import ModelProxyService

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> ModelProxyService:
    """应用生命周期统一拥有供应商代理。"""
    return cast(ModelProxyService, request.app.state.services.model_proxy)


def token(request: Request) -> str:
    """专用Connector入口不接受Cookie或浏览器访问令牌替代设备凭据。"""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise DomainError(401, "invalid connector access token")
    return header[7:]


async def response(iterator: AsyncIterator[bytes], streaming: bool) -> StreamingResponse:
    """先读取首块使配置或连接错误仍返回正确HTTP状态，断开后可靠关闭生成器。"""
    first = await anext(iterator, b"")

    async def chunks() -> AsyncIterator[bytes]:
        try:
            if first:
                yield first
            async for chunk in iterator:
                yield chunk
        finally:
            close = getattr(iterator, "aclose", None)
            if close:
                await close()

    return StreamingResponse(
        chunks(),
        media_type="text/event-stream" if streaming else "application/json",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/connector/models/catalog")
async def catalog(request: Request) -> dict[str, object]:
    """设备目录采用设备所属账号权限和个人默认模型。"""
    account, _ = await service(request).connector(token(request))
    return await service(request).models.catalog(account)


@router.post("/models/{provider_id}/{protocol}/{operation:path}")
async def browser(
    provider_id: str,
    protocol: str,
    operation: str,
    body: dict[str, object],
    request: Request,
    account: AccountDep,
) -> StreamingResponse:
    """浏览器调用仍须绑定该账号拥有且未封禁的执行设备。"""
    connector = request.headers.get("x-superdsh-connector-id")
    if not connector:
        raise DomainError(422, "需要执行设备标识")
    return await response(
        service(request).forward(
            account,
            provider_id,
            protocol,
            operation,
            body,
            connector,
            protocol_headers=dict(request.headers),
            access_token=token(request),
        ),
        body.get("stream") is True,
    )


@router.post("/connector/models/{provider_id}/{protocol}/{operation:path}")
async def connector(
    provider_id: str, protocol: str, operation: str, body: dict[str, object], request: Request
) -> StreamingResponse:
    """设备令牌及凭据代际在整个生成期间持续复验。"""
    account, principal = await service(request).connector(token(request))
    return await response(
        service(request).forward(
            account,
            provider_id,
            protocol,
            operation,
            body,
            str(principal["id"]),
            str(principal["tokenHash"]),
            dict(request.headers),
        ),
        body.get("stream") is True,
    )


@router.get("/agents/{runtime}/model-catalog", status_code=410)
@router.get("/agents/{runtime}/permission-catalog", status_code=410)
async def retired_catalog(runtime: str, request: Request, account: AccountDep) -> JSONResponse:
    """历史目录入口保持明确的迁移提示，不从别的设备猜测运行实例。"""
    kind = "model" if request.url.path.endswith("/model-catalog") else "permission"
    return JSONResponse(
        {
            "detail": {
                "code": "agent_catalog_route_removed",
                "message": "Agent catalog query routes were removed from the target API.",
                "use": f"/connectors/{{connectorId}}/runtimes/{runtime}/catalogs/{kind}",
            }
        },
        status_code=410,
        headers={"Cache-Control": "no-store"},
    )
