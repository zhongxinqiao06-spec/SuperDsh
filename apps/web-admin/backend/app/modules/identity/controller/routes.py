"""认证及账号管理路由；只做 DTO、授权和 Cookie 协议转换。"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Body, Depends, Query, Request, Response

from app.api.dependencies import current_account, require_permission
from app.infrastructure.errors import DomainError
from app.infrastructure.query_parameters import query_integer
from app.modules.identity.entity.bo.models import PERMISSIONS, Account
from app.modules.identity.entity.vo.dto import (
    LoginInput,
    PasswordInput,
    PasswordSaltInput,
    RefreshInput,
    RegisterInput,
    RoleInput,
    UserCreateInput,
    UserPatchInput,
    account_payload,
    role_payload,
)
from app.modules.identity.service.identity import IdentityService, Login
from app.modules.identity.service.management import AccountManagement

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def identity(request: Request) -> IdentityService:
    """身份服务由应用装配注入，不在路由初始化数据库。"""
    return request.app.state.services.identity


def management(request: Request) -> AccountManagement:
    """管理用例公开接口，路由不持有 ORM Session。"""
    return request.app.state.services.management


def check_origin(request: Request) -> None:
    """存在 Origin 时精确校验；兼容未发送该头的现有原生客户端。"""
    origins = set(request.app.state.settings.allowed_origins) | {
        request.app.state.settings.public_origin
    }
    origin = request.headers.get("origin")
    if origin and origin not in origins:
        raise DomainError(403, "untrusted cookie request origin")


def refresh_cookie(request: Request, response: Response, value: str = "") -> None:
    """设置和清除使用同一入口派生 Path，保证旧 Cookie 不残留。"""
    name, path = request.app.state.compatibility.cookie(request.scope, "refresh")
    response.set_cookie(
        name,
        value,
        max_age=30 * 86400 if value else 0,
        path=path,
        httponly=True,
        secure=request.app.state.settings.public_origin.startswith("https:"),
        samesite="strict",
    )


def login_payload(
    request: Request, response: Response, login: Login, native: bool
) -> dict[str, object]:
    """浏览器只获得 access token，刷新令牌通过 HttpOnly Cookie 传递。"""
    if not native:
        refresh_cookie(request, response, login.refresh_token)
    response.headers["Cache-Control"] = "no-store"
    return {
        **account_payload(login.account),
        "accessToken": login.access_token,
        "refreshToken": login.refresh_token if native else None,
        "expiresIn": 900,
        "tokenType": "bearer",
    }


@router.get("/auth/config")
async def configuration(request: Request) -> dict[str, object]:
    """展示真实初始化状态；未配置的外部认证明确标记不可用。"""
    return await request.app.state.services.accounts.configuration()


@router.post("/auth/password-salt")
async def salt(body: PasswordSaltInput, request: Request) -> dict[str, str]:
    """密码挑战接口不返回账号存在性。"""
    return {
        "salt": await identity(request).password_salt(body.identifier or body.email),
        "serverTime": datetime.now(UTC).isoformat(),
    }


@router.post("/auth/login")
async def login(body: LoginInput, request: Request, response: Response) -> dict[str, object]:
    """网页登录不会准备 DSH；原生端凭据表达保持兼容。"""
    result = await identity(request).login(
        body.identifier or body.email, body.password, body.passwordVerifier, body.clientName
    )
    await request.app.state.services.resources.initialize(result.account)
    return login_payload(request, response, result, body.clientType == "native")


async def registration_access(request: Request) -> None:
    """空库兼容初始化先验证凭据，避免 DTO 校验改变原有鉴权优先级。"""
    if await identity(request).needs_bootstrap():
        value = await request.json() if await request.body() else {}
        token = value.get("setupToken", "") if isinstance(value, dict) else ""
        identity(request).validate_setup_token(token if isinstance(token, str) else "")


@router.post("/auth/register", dependencies=[Depends(registration_access)])
async def register(body: RegisterInput, request: Request, response: Response) -> dict[str, object]:
    """只在独立新空库中创建首个管理员。"""
    if await identity(request).needs_bootstrap():
        account = await identity(request).bootstrap(
            body.username,
            body.password,
            body.passwordVerifier,
            body.passwordSalt,
            body.setupToken,
            body.displayName,
            body.email,
        )
    else:
        account = await request.app.state.services.accounts.register(body)
    result = await identity(request).issue_login(account.user_id, body.clientName)
    await request.app.state.services.resources.initialize(result.account)
    return login_payload(request, response, result, body.clientType == "native")


@router.post("/auth/refresh")
async def refresh(
    request: Request, response: Response, body: Annotated[RefreshInput | None, Body()] = None
) -> dict[str, object]:
    """单次刷新由数据库行锁轮换，浏览器另外检查 Origin。"""
    body = body or RefreshInput()
    if not body.refreshToken:
        check_origin(request)
    name, _ = request.app.state.compatibility.cookie(request.scope, "refresh")
    result = await identity(request).refresh(body.refreshToken or request.cookies.get(name, ""))
    return login_payload(request, response, result, bool(body.refreshToken))


@router.post("/auth/logout", status_code=204)
async def logout(
    request: Request, response: Response, body: Annotated[RefreshInput | None, Body()] = None
) -> None:
    """登出幂等，访问令牌已过期时仍可撤销有效刷新 Cookie。"""
    body = body or RefreshInput()
    if not body.refreshToken:
        check_origin(request)
    account: Account | None = None
    if request.headers.get("authorization"):
        try:
            account = await current_account(request)
        except DomainError:
            pass
    name, _ = request.app.state.compatibility.cookie(request.scope, "refresh")
    await identity(request).logout(body.refreshToken or request.cookies.get(name), account)
    refresh_cookie(request, response)


@router.get("/auth/me")
async def me(account: AccountDep) -> dict[str, object]:
    """返回当前授权，角色变更立即使旧令牌失效。"""
    return account_payload(account)


@router.get("/auth/sessions")
async def sessions(
    request: Request,
    account: AccountDep,
    page: str | None = Query(None),
    pageSize: str | None = Query(None),
    search: str = Query(""),
) -> dict[str, object]:
    """列出本人设备登录会话，不枚举其他账号。"""
    page_number = query_integer(page, 1, 1)
    page_size = query_integer(pageSize, 200, 1, 200)
    values = await identity(request).list_sessions(account)
    values = [
        value
        for value in values
        if search.casefold() in str(value.get("clientName", "")).casefold()
    ]
    return {
        "sessions": values[(page_number - 1) * page_size : page_number * page_size],
        "total": len(values),
        "page": page_number,
        "pageSize": page_size,
    }


@router.delete("/auth/sessions/{session_id}", status_code=204)
async def revoke_session(session_id: str, request: Request, account: AccountDep) -> None:
    """撤销指定本人会话，已签发的访问令牌同步失效。"""
    await identity(request).revoke_session(account, session_id)


@router.post("/auth/logout-all", status_code=204)
async def logout_all(request: Request, response: Response, account: AccountDep) -> None:
    """仅撤销本人所有登录会话。"""
    await identity(request).logout(None, account, True)
    refresh_cookie(request, response)


@router.post("/auth/change-password", status_code=204)
async def change_password(
    body: PasswordInput, request: Request, response: Response, account: AccountDep
) -> None:
    """本人改密后要求重新登录。"""
    await identity(request).change_password(
        account, body.newPassword, body.newPasswordVerifier, body.newPasswordSalt
    )
    refresh_cookie(request, response)


@router.get("/admin/users")
async def users(
    request: Request,
    account: Annotated[Account, Depends(require_permission("users.read"))],
    page: str | None = Query(None),
    pageSize: str | None = Query(None),
    search: str = Query(""),
) -> dict[str, object]:
    """分页搜索真实账号，记录总数而非前端假数据。"""
    page_number = query_integer(page, 1, 1)
    page_size = query_integer(pageSize, 50, 1, 200)
    values, total = await management(request).list_users(account, page_number, page_size, search)
    return {
        "users": [account_payload(value) for value in values],
        "total": total,
        "page": page_number,
        "pageSize": page_size,
        "serverTime": datetime.now(UTC).isoformat(),
    }


@router.post("/admin/users", status_code=201)
async def create_user(
    body: UserCreateInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """管理创建采用与初始化相同的密码挑战实现。"""
    user = await management(request).create_user(
        account,
        body.username,
        body.password,
        body.passwordVerifier,
        body.passwordSalt,
        body.roles,
        body.displayName,
        body.email,
    )
    return account_payload(user)


@router.patch("/admin/users/{user_id}")
async def update_user(
    user_id: str, body: UserPatchInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """并发编辑冲突返回稳定 409，禁止直接设置他人密码。"""
    return account_payload(
        await management(request).update_user(account, user_id, body.model_dump(exclude_unset=True))
    )


@router.delete("/admin/users/{user_id}", status_code=204)
async def delete_user(user_id: str, request: Request, account: AccountDep) -> None:
    """软删除保留资源归属，并保护本人及最后管理员。"""
    await management(request).update_user(account, user_id, {}, "delete")


@router.post("/admin/users/{user_id}/restore")
async def restore_user(user_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    """恢复账号不会恢复已经失效的登录令牌。"""
    return account_payload(await management(request).update_user(account, user_id, {}, "restore"))


@router.post("/admin/users/{user_id}/password-reset")
async def reset_user(user_id: str, request: Request, account: AccountDep) -> dict[str, str]:
    """管理员只能标记本人恢复要求，不获知或设置其他用户密码。"""
    await management(request).update_user(account, user_id, {}, "reset")
    return {"status": "recovery_required"}


@router.get("/admin/roles")
async def roles(request: Request, account: AccountDep) -> dict[str, object]:
    """返回真实角色及统一权限目录。"""
    return {
        "roles": [role_payload(role) for role in await management(request).list_roles(account)],
        "permissions": [{"id": key, "label": label} for key, label in PERMISSIONS.items()],
    }


@router.post("/admin/roles", status_code=201)
async def create_role(body: RoleInput, request: Request, account: AccountDep) -> dict[str, object]:
    """只可授予当前管理员持有的权限。"""
    return role_payload(
        await management(request).save_role(
            account, None, body.name, body.description, body.permissions, None
        )
    )


@router.patch("/admin/roles/{role_id}")
async def update_role(
    role_id: str, body: RoleInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """角色修改原子撤销引用账号的旧授权代际。"""
    return role_payload(
        await management(request).save_role(
            account, role_id, body.name, body.description, body.permissions, body.revision
        )
    )


@router.delete("/admin/roles/{role_id}", status_code=204)
async def delete_role(role_id: str, request: Request, account: AccountDep) -> None:
    """拒绝删除内置或仍有账号引用的角色。"""
    await management(request).delete_role(account, role_id)
