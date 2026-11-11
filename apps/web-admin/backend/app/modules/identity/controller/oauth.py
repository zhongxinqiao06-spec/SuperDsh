"""OAuth 协议路由与兼容入口链接，外部 IdP 未配置时明确失败。"""

from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, Request, Response
from pydantic import ValidationError
from starlette.responses import RedirectResponse

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.modules.identity.controller.routes import login_payload
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.vo.account_vo import OAuthFinalizeInput
from app.modules.identity.entity.vo.oauth import AuthorizeInput
from app.modules.identity.service.oauth import OAuthService

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def oauth(request: Request) -> OAuthService:
    return request.app.state.services.oauth


@router.get("/.well-known/oauth-authorization-server")
async def metadata(request: Request) -> dict[str, object]:
    """OAuth metadata 从可信 origin 与唯一兼容清单派生本服务链接。"""
    catalog = request.app.state.compatibility
    origin = request.app.state.settings.public_origin
    return {
        "issuer": origin,
        "authorization_endpoint": origin + catalog.outward(request.scope, "/api/oauth/authorize"),
        "token_endpoint": origin + catalog.outward(request.scope, "/api/oauth/token", "POST"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "code_challenge_methods_supported": ["S256"],
    }


@router.post("/oauth/authorize")
async def authorize(body: AuthorizeInput, request: Request, account: AccountDep) -> dict[str, str]:
    """授权页面已登录后生成一次性客户端回调。"""
    target = await oauth(request).authorize(
        account,
        body.client_id,
        body.redirect_uri,
        body.code_challenge,
        body.code_challenge_method,
        body.response_type,
        body.state,
        body.scope,
    )
    return {"redirectUrl": target, "serverTime": datetime.now(UTC).isoformat()}


@router.get("/oauth/authorize")
async def authorize_get(request: Request, account: AccountDep) -> RedirectResponse:
    """OAuth 规范要求的回调重定向，不用于兼容 API 路径。"""
    try:
        body = AuthorizeInput.model_validate(dict(request.query_params))
    except ValidationError as error:
        raise DomainError(422, "invalid authorization parameters") from error
    target = await authorize(body, request, account)
    return RedirectResponse(
        target["redirectUrl"], status_code=302, headers={"Cache-Control": "no-store"}
    )


@router.post("/oauth/token")
async def exchange(request: Request, response: Response) -> dict[str, object]:
    """限长读取标准表单，兑换结果禁止缓存。"""
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > 16384:
            raise DomainError(413, "request too large")
        raw.extend(chunk)
    try:
        body = {
            key: values[0]
            for key, values in parse_qs(
                raw.decode(), keep_blank_values=True, max_num_fields=20
            ).items()
        }
    except (ValueError, UnicodeDecodeError) as error:
        raise DomainError(422, "invalid token request") from error
    if body.get("grant_type") != "authorization_code":
        raise DomainError(422, "grant_type must be authorization_code")
    login, scope = await oauth(request).exchange(
        body.get("code", ""),
        body.get("client_id", ""),
        body.get("redirect_uri", ""),
        body.get("code_verifier", ""),
    )
    response.headers.update({"Pragma": "no-cache", "Cache-Control": "no-store"})
    return {
        "access_token": login.access_token,
        "refresh_token": login.refresh_token,
        "token_type": "bearer",
        "expires_in": 900,
        "scope": scope,
    }


def state_cookie(request: Request, response: Response, value: str = "") -> None:
    """Cookie 路径随兼容入口派生，回调与开始地址始终使用相同身份。"""
    path = request.app.state.compatibility.outward(request.scope, "/api/auth/oauth/start").rsplit(
        "/", 1
    )[0]
    response.set_cookie(
        "superdsh_oauth_state",
        value,
        max_age=600 if value else 0,
        path=path,
        httponly=True,
        secure=request.app.state.settings.public_origin.startswith("https:"),
        samesite="lax",
    )


@router.get("/auth/oauth/start")
async def external_start(
    request: Request, response: Response, returnTo: str = ""
) -> dict[str, object]:
    services = request.app.state.services
    callback = request.app.state.settings.public_origin + request.app.state.compatibility.outward(
        request.scope, "/api/auth/oauth/callback"
    )
    target, token = await services.accounts.external.start(returnTo, callback)
    state_cookie(request, response, services.accounts.security.hash_token(token))
    response.headers["Cache-Control"] = "no-store"
    return {"authorizeUrl": target, "serverTime": datetime.now(UTC).isoformat()}


@router.get("/auth/oauth/callback")
async def external_callback(
    request: Request, state: str = "", code: str = "", error: str = ""
) -> RedirectResponse:
    try:
        target = await request.app.state.services.accounts.external.callback(
            state, request.cookies.get("superdsh_oauth_state", ""), code, error
        )
    except DomainError:
        # 浏览器回调始终返回产品入口展示错误，不把失败回调留在 JSON 页面。
        target = request.app.state.settings.public_origin + "/?oauth_error=invalid+oauth+state"
    response = RedirectResponse(target, status_code=302, headers={"Cache-Control": "no-store"})
    state_cookie(request, response)
    return response


@router.post("/auth/oauth/finalize")
async def external_finalize(
    body: OAuthFinalizeInput, request: Request, response: Response
) -> dict[str, object]:
    result = await request.app.state.services.accounts.external.finalize(body)
    await request.app.state.services.resources.initialize(result.account)
    return login_payload(request, response, result, False)
