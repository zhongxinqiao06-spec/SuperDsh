"""个人资料、恢复码、邮箱和手机确认协议；所有变更交由身份用例。"""

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response

from app.api.dependencies import current_account
from app.infrastructure.query_parameters import query_integer
from app.modules.identity.controller.routes import login_payload
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.vo.account_vo import (
    AvatarInput,
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
