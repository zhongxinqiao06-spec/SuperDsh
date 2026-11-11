"""HTTP/WS 可复用的认证依赖，账号权限由当前数据库状态决定。"""

from collections.abc import Awaitable, Callable

from fastapi import Request

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.identity import IdentityService


async def current_account(request: Request) -> Account:
    """只接受 Bearer 访问令牌，不把刷新 Cookie 当业务授权。"""
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        raise DomainError(401, "login session expired or revoked")
    identity: IdentityService = request.app.state.services.identity
    return await identity.authenticate(authorization[7:])


def require_permission(permission: str) -> Callable[[Request], Awaitable[Account]]:
    """返回具名权限依赖；菜单可见性不代替这个服务端判断。"""

    async def authorize(request: Request) -> Account:
        account = await current_account(request)
        account.require(permission)
        return account

    return authorize
