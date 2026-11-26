"""个人资料、恢复码、邮箱和手机确认协议；所有变更交由身份用例。"""

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.infrastructure.query_parameters import query_integer
from app.modules.identity.controller.routes import check_origin, login_payload, refresh_cookie
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.product_roles import PRODUCTS
from app.modules.identity.entity.vo.account_vo import (
    AvatarInput,
    CloseAccountInput,
    EmailCodeInput,
    EmailInput,
    MobileInput,
    ProfileInput,
    RecoveryInput,
    UsernameInput,
)
from app.modules.identity.service.account_service import AccountFlows
from app.modules.identity.service.identity import Login

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def accounts(request: Request) -> AccountFlows:
    return request.app.state.services.accounts


@router.delete("/auth/me", status_code=202)
async def close_account(
    body: CloseAccountInput, request: Request, response: Response, account: AccountDep
) -> dict[str, str]:
    """仅注销当前登录者；提交后撤销会话并清除浏览器刷新 Cookie。"""
    check_origin(request)
    browser = "origin" in request.headers or "sec-fetch-mode" in request.headers
    if browser and body.product is None:
        # 已打开的旧网页不会随部署换版；在删除之前提示刷新，保留账号和额度。
        raise DomainError(
            409, "页面已更新，账号仍然保留。请刷新本页后重新确认注销。", "refresh_before_erasure"
        )
    products = [key for key in PRODUCTS if f"products.{key}" in account.permissions]
    # 单产品账号按当前有效权限返回；双产品账号沿用用户正在操作的工作台。
    product = products[0] if len(products) == 1 else body.product
    await accounts(request).close_account(account, body.accountId)
    refresh_cookie(request, response)
    response.headers["Cache-Control"] = "no-store"
    result = {"status": "closed"}
    if body.product and product:
        result["product"] = product
    return result


@router.put("/auth/me/profile")
async def profile(body: ProfileInput, request: Request, account: AccountDep) -> dict[str, object]:
    return await accounts(request).profile(account, {"display_name": body.displayName})


@router.put("/auth/me/username")
async def username(body: UsernameInput, request: Request, account: AccountDep) -> dict[str, object]:
    return await accounts(request).profile(account, {"username": body.username})


@router.put("/auth/me/avatar")
async def avatar(body: AvatarInput, request: Request, account: AccountDep) -> dict[str, object]:
    return await accounts(request).profile(account, {"avatar_url": body.avatar})


@router.delete("/auth/me/avatar")
async def clear_avatar(request: Request, account: AccountDep) -> dict[str, object]:
    return await accounts(request).profile(account, {"avatar_url": None})


@router.put("/auth/me/email")
async def bind_email(body: EmailInput, request: Request, account: AccountDep) -> dict[str, object]:
    return await accounts(request).bind_email(account, body)


@router.post("/auth/email-code")
async def email_code(body: EmailCodeInput, request: Request) -> dict[str, object]:
    account = await current_account(request) if request.headers.get("authorization") else None
    return await accounts(request).issue_email(body, account)


@router.post("/auth/recovery-codes")
async def recovery_codes(request: Request, account: AccountDep) -> dict[str, object]:
    return await accounts(request).recovery_codes(account)


@router.post("/auth/recovery/reset", status_code=204)
async def recovery_reset(body: RecoveryInput, request: Request) -> None:
    await accounts(request).reset_password(body)


@router.post("/auth/recovery/reset-email", status_code=204)
async def recovery_email(body: RecoveryInput, request: Request) -> None:
    await accounts(request).reset_password(body, email=True)


@router.get("/admin/audit")
async def audit_logs(
    request: Request,
    account: AccountDep,
    page: str | None = Query(None),
    pageSize: str | None = Query(None),
    search: str = Query(""),
    action: str = Query("", max_length=200),
) -> dict[str, object]:
    return await accounts(request).audit_page(
        account, query_integer(page, 1, 1), query_integer(pageSize, 200, 1, 200), search, action
    )


@router.post("/auth/mobile-login/qr")
async def mobile_qr(request: Request, account: AccountDep) -> dict[str, object]:
    return await accounts(request).mobile.create(account)


@router.post("/auth/mobile-login/{operation}")
async def mobile_operation(
    operation: str, body: MobileInput, request: Request, response: Response
) -> dict[str, object]:
    from app.infrastructure.errors import DomainError

    if operation not in {"request", "status", "confirm", "exchange"}:
        raise DomainError(404, "unknown mobile login operation")
    account = await current_account(request) if operation == "confirm" else None
    result = await accounts(request).mobile.operate(operation, body, account)
    if isinstance(result, Login):
        return {
            "auth": login_payload(request, response, result, True),
            "refreshToken": result.refresh_token,
            "expiresAt": (datetime.now(UTC) + timedelta(days=30)).isoformat(),
            "serverTime": datetime.now(UTC).isoformat(),
        }
    return result
