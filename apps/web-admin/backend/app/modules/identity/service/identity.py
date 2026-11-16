"""登录、刷新、撤销与初始化用例，事务中重复检查当前身份。"""

import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import (
    PERMISSIONS,
    Account,
    LoginSession,
    Role,
    User,
)
from app.modules.identity.entity.bo.product_roles import ROLE_TITLES, Product, builtin_grants
from app.modules.identity.entity.bo.validation import account_username, login_identifier
from app.modules.identity.entity.bo.validation import display_name as validated_display_name
from app.modules.identity.service.ports import (
    IdentityRepository,
    IdentitySecurity,
    IdentityTransaction,
)


@dataclass
class Login:
    """仅交给协议层的登录结果；Web 刷新凭据不能放入 JSON。"""

    account: Account
    access_token: str
    refresh_token: str


async def resolve_account(tx: IdentityTransaction, user: User, session_id: str = "") -> Account:
    """按最新角色解析授权，不能只信令牌中的历史权限。"""
    roles = {role.id: role for role in await tx.roles()}
    permissions = sorted(
        {
            permission
            for role in user.roles
            if role in roles
            for permission in roles[role].permissions
        }
    )
    return Account(
        user.id,
        user.username,
        tuple(user.roles),
        tuple(permissions),
        user.auth_version,
        user.disabled,
        session_id,
        user.email,
        user.display_name,
        user.deleted_at,
        user.reset_required,
        user.revision,
        user.avatar_url,
        user.email_verified_at,
        user.created_at,
        user.updated_at,
    )


async def current_actor(tx: IdentityTransaction, actor: Account, permission: str) -> Account:
    """写事务内重新读取授权，防止请求鉴权之后发生撤权。"""
    user = await tx.user(actor.user_id)
    if not user or user.auth_version != actor.auth_version:
        raise DomainError(401, "login session expired or revoked")
    current = await resolve_account(tx, user, actor.session_id)
    current.require(permission)
    return current


class IdentityService:
    """身份公开用例，管理页面访问不会启动执行引擎。"""

    def __init__(
        self,
        repository: IdentityRepository,
        security: IdentitySecurity,
        setup_token: str,
        setup_expires_at: datetime | None = None,
    ) -> None:
        self.repository = repository
        self.security = security
        self.setup_token = setup_token
        self.setup_expires_at = setup_expires_at or datetime.fromtimestamp(0, UTC)

    async def initialize(self) -> None:
        """幂等创建内置角色，不修改已有账号或用户定制权限。"""
        async with self.repository.transaction() as tx:
            await tx.lock()
            existing = {role.id for role in await tx.roles()}
            for role_id, grants in builtin_grants(PERMISSIONS).items():
                if role_id not in existing:
                    await tx.save_role(
                        Role(role_id, ROLE_TITLES[role_id], "", grants, builtin=True)
                    )

    async def audit(
        self, actor: str | None, action: str, target: str, detail: dict[str, object]
    ) -> None:
        """其他领域通过公开服务记录已脱敏事实，不直接操作身份审计表。"""
        async with self.repository.transaction() as tx:
            await tx.audit(actor, action, target, detail)

    async def role_exists(self, ids: list[str]) -> bool:
        """资源权限配置仅验证角色标识，不泄露账号和身份仓储。"""
        async with self.repository.transaction() as tx:
            choices = {role.id for role in await tx.roles()}
            return all(value in choices for value in ids)

    async def needs_bootstrap(self) -> bool:
        """配置初始化或兼容初始化完成后，关闭首次管理员注册入口。"""
        async with self.repository.transaction() as tx:
            return not await tx.users()

    async def initialize_admin(
        self, username: str, password: str, display_name: str
    ) -> Account | None:
        """按已校验的服务端配置创建空库管理员；已有账号、密码和权限绝不覆盖。"""
        if not username and not password:
            return None
        if not username or not password:
            raise DomainError(422, "initial administrator credentials must be configured together")
        async with self.repository.transaction() as tx:
            if await tx.users():
                return None
        # 密码计算不占用数据库事务；随后与兼容初始化共用锁并重新检查空库。
        hashed = await self.security.hash_password(password, None, None)
        async with self.repository.transaction() as tx:
            await tx.lock()
            if await tx.users():
                return None
            user = User(
                str(uuid4()),
                username,
                hashed,
                ["admin"],
                display_name=display_name or None,
                created_at=datetime.now(UTC),
            )
            await tx.save_user(user)
            await tx.audit(user.id, "account.bootstrap", user.id, {"source": "configuration"})
            return await resolve_account(tx, user)

    async def product_role_ids(self, account: Account, product: Product) -> tuple[str, ...]:
        """同一账号切换产品时只匹配本产品角色，平台角色覆盖其显式拥有的产品。"""
        account.require("products." + product)
        async with self.repository.transaction() as tx:
            roles = await tx.roles()
        return tuple(
            role.id
            for role in roles
            if role.id in account.roles and "products." + product in role.permissions
        )

    async def _menu_roles(self, account: Account, product: Product | None) -> list[Role]:
        """全局菜单管理沿用既有权限，产品菜单管理只枚举拥有本产品授权的角色。"""
        global_grant = next(
            (key for key in ("menus.read", "menus.manage") if key in account.permissions), None
        )
        if global_grant:
            account.require(global_grant)
        elif product is not None:
            account.require_product_management(product, "menus")
        else:
            account.require("menus.read")
        async with self.repository.transaction() as tx:
            roles = await tx.roles()
        if global_grant:
            return roles
        return [
            role
            for role in roles
            if role.id != "admin" and f"products.{product}" in role.permissions
        ]

    async def role_choices(
        self, account: Account, product: Product | None = None
    ) -> list[dict[str, str]]:
        """菜单配置只获得可编排角色的公开标识与名称。"""
        return [
            {"id": role.id, "name": role.name} for role in await self._menu_roles(account, product)
        ]

    async def menu_role_permissions(
        self, account: Account, product: Product, role_id: str
    ) -> list[str]:
        """预览使用持久化角色的真实权限，普通菜单管理员不能模拟超管。"""
        roles = await self._menu_roles(account, product)
        role = next((r for r in roles if r.id == role_id), None)
        if role is None or (role.id == "admin" and "admin" not in account.roles):
            raise DomainError(404, "role not available for this product")
        if f"products.{product}" not in role.permissions:
            # 平台菜单管理员可查看所有角色，未开通目标产品时预览应当为空。
            return []
        # 不向本产品的预览上下文附加该角色在另一端的管理授权。
        return [
            permission
            for permission in role.permissions
            if not permission.startswith("products.")
            or permission == f"products.{product}"
            or permission.startswith(f"products.{product}.")
        ]

    async def bootstrap(
        self,
        username: str,
        password: str | None,
        verifier: str | None,
        salt: str | None,
        setup_token: str,
        display_name: str | None,
        email: str | None,
    ) -> Account:
        """并发初始化用事务锁仲裁；只允许创建首个管理员。"""
        self.validate_setup_token(setup_token)
        username = account_username(username, email)
        display_name = validated_display_name(display_name)
        hashed = await self.security.hash_password(password, verifier, salt)
        async with self.repository.transaction() as tx:
            await tx.lock()
            if await tx.users():
                raise DomainError(403, "registration is closed")
            user = User(
                str(uuid4()),
                username,
                hashed,
                ["admin"],
                email,
                display_name,
                created_at=datetime.now(UTC),
                email_verified_at=datetime.now(UTC) if email else None,
            )
            await tx.save_user(user)
            await tx.audit(user.id, "account.bootstrap", user.id, {})
            return await resolve_account(tx, user)

    def validate_setup_token(self, setup_token: str) -> None:
        """兼容手动空库初始化入口先鉴权再校验业务字段，自动配置建管理员不经过此门禁。"""
        if (
            not self.setup_token
            or datetime.now(UTC) > self.setup_expires_at
            or not hmac.compare_digest(setup_token.encode(), self.setup_token.encode())
        ):
            raise DomainError(
                401, "invalid or expired setup token — find the current token in the server log"
            )

    async def get_account(self, user_id: str) -> Account:
        """其他模块通过此方法读取最新账号状态，不跨域访问身份表。"""
        async with self.repository.transaction() as tx:
            user = await tx.user(user_id)
            if not user or user.disabled or user.deleted_at:
                raise DomainError(401, "login session expired or revoked")
            return await resolve_account(tx, user)

    async def authenticate(self, token: str) -> Account:
        """访问令牌必须同时匹配有效会话、账号代际与当前状态。"""
        try:
            claims = self.security.decode(token)
        except Exception as error:
            raise DomainError(401, "login session expired or revoked") from error
        async with self.repository.transaction() as tx:
            session = await tx.session(str(claims["sid"]))
            user = await tx.user(str(claims["sub"]))
            if (
                not session
                or not user
                or session.user_id != user.id
                or session.revoked_at
                or session.expires_at <= datetime.now(UTC)
                or user.disabled
                or user.deleted_at
                or claims["ver"] != user.auth_version
                or session.auth_version != user.auth_version
            ):
                raise DomainError(401, "login session expired or revoked")
            now = datetime.now(UTC)
            if not session.last_seen_at or session.last_seen_at <= now - timedelta(minutes=1):
                await tx.touch_session(session.id, now)
            return await resolve_account(tx, user, session.id)

    async def password_salt(self, identifier: str) -> str:
        """未知账号返回随机盐，不能通过接口直接枚举是否存在。"""
        identifier = login_identifier(identifier)
        async with self.repository.transaction() as tx:
            user = await tx.find_user(identifier)
            return (
                user.password_hash.split("$")[1]
                if user
                and not user.disabled
                and not user.deleted_at
                and ("@" not in identifier or user.email_verified_at)
                else secrets.token_urlsafe(16)
            )

    async def login(
        self, identifier: str, password: str | None, verifier: str | None, client_name: str
    ) -> Login:
        """密码验证后在新事务复验账号，避免计算期间撤权被忽略。"""
        identifier = login_identifier(identifier)
        async with self.repository.transaction() as tx:
            user = await tx.find_user(identifier)
        if (
            not user
            or ("@" in identifier and not user.email_verified_at)
            or not await self.security.verify(user.password_hash, password, verifier)
        ):
            raise DomainError(401, "invalid credentials")
        return await self.issue_login(user.id, client_name, expected_hash=user.password_hash)

    async def issue_login(
        self,
        user_id: str,
        client_name: str,
        expected_hash: str | None = None,
        expected_version: int | None = None,
    ) -> Login:
        """签发访问/刷新凭据并持久化，提交成功才返回。"""
        async with self.repository.transaction() as tx:
            await tx.lock()
            user = await tx.user(user_id)
            if (
                not user
                or user.disabled
                or user.deleted_at
                or (expected_hash and user.password_hash != expected_hash)
                or (expected_version is not None and expected_version != user.auth_version)
            ):
                raise DomainError(401, "invalid credentials")
            now = datetime.now(UTC)
            session_id = str(uuid4())
            refresh = session_id + "." + secrets.token_urlsafe(48)
            session = LoginSession(
                session_id,
                user.id,
                self.security.hash_token(refresh),
                user.auth_version,
                client_name[:80] or "Browser",
                now,
                now + timedelta(days=30),
                last_seen_at=now,
            )
            await tx.save_session(session)
            account = await resolve_account(tx, user, session_id)
            return Login(
                account, self.security.issue(user.id, session_id, user.auth_version), refresh
            )

    async def refresh(self, token: str) -> Login:
        """串行刷新并检测旧令牌重放；撤销必须提交后再返回失败。"""
        result: Login | None = None
        async with self.repository.transaction() as tx:
            session = await tx.session(token.split(".")[0], lock=True)
            if session and not session.revoked_at and session.expires_at > datetime.now(UTC):
                hashed = self.security.hash_token(token)
                user = await tx.user(session.user_id)
                if (
                    hmac.compare_digest(session.refresh_hash, hashed)
                    and user
                    and not user.disabled
                    and not user.deleted_at
                    and user.auth_version == session.auth_version
                ):
                    replacement = session.id + "." + secrets.token_urlsafe(48)
                    session.previous_refresh_hash = session.refresh_hash
                    session.refresh_hash = self.security.hash_token(replacement)
                    session.last_seen_at = datetime.now(UTC)
                    await tx.save_session(session)
                    result = Login(
                        await resolve_account(tx, user, session.id),
                        self.security.issue(user.id, session.id, user.auth_version),
                        replacement,
                    )
                elif session.previous_refresh_hash and hmac.compare_digest(
                    session.previous_refresh_hash, hashed
                ):
                    session.revoked_at = datetime.now(UTC)
                    await tx.save_session(session)
        if result is None:
            raise DomainError(401, "login session expired or revoked")
        return result

    async def logout(
        self, token: str | None, account: Account | None, all_sessions: bool = False
    ) -> None:
        """分别撤销刷新凭据和访问凭据所属会话，兼容跨标签页使用不同凭据的登出。"""
        async with self.repository.transaction() as tx:
            candidates = await tx.sessions(account.user_id) if all_sessions and account else []
            if not all_sessions:
                # 两种凭据分别验证；无效刷新令牌不能阻止有效访问会话登出。
                identifiers = sorted(
                    {
                        value
                        for value in (
                            token.split(".")[0] if token else "",
                            account.session_id if account else "",
                        )
                        if value
                    }
                )
                for identifier in identifiers:
                    target = await tx.session(identifier, lock=True)
                    if target and (
                        (
                            token
                            and hmac.compare_digest(
                                target.refresh_hash, self.security.hash_token(token)
                            )
                        )
                        or (
                            account
                            and target.id == account.session_id
                            and target.user_id == account.user_id
                        )
                    ):
                        candidates.append(target)
            for session in candidates:
                session.revoked_at = datetime.now(UTC)
                await tx.save_session(session)

    async def list_sessions(self, account: Account) -> list[dict[str, object]]:
        """只返回本人有效会话的公开元数据，不返回令牌或摘要。"""
        async with self.repository.transaction() as tx:
            return [
                {
                    "id": value.id,
                    "clientName": value.client_name,
                    "createdAt": value.created_at.isoformat(),
                    "lastSeenAt": value.last_seen_at.isoformat() if value.last_seen_at else None,
                    "expiresAt": value.expires_at.isoformat(),
                    "current": value.id == account.session_id,
                }
                for value in await tx.sessions(account.user_id)
                if not value.revoked_at and value.expires_at > datetime.now(UTC)
            ]

    async def revoke_session(self, account: Account, session_id: str) -> None:
        """逐会话撤销在行锁中检查归属，他人 ID 与不存在记录保持同一响应。"""
        async with self.repository.transaction() as tx:
            session = await tx.session(session_id, lock=True)
            if session is None or session.user_id != account.user_id:
                return
            session.revoked_at = datetime.now(UTC)
            await tx.save_session(session)

    async def change_password(
        self, account: Account, password: str | None, verifier: str | None, salt: str | None
    ) -> None:
        """改密递增授权代际并撤销全部会话，旧 access token 立即失效。"""
        hashed = await self.security.hash_password(password, verifier, salt)
        async with self.repository.transaction() as tx:
            await tx.lock()
            user = await tx.user(account.user_id)
            if (
                not user
                or user.auth_version != account.auth_version
                or user.disabled
                or user.deleted_at
            ):
                raise DomainError(401, "login session expired or revoked")
            user.password_hash, user.reset_required = hashed, False
            user.auth_version += 1
            user.revision += 1
            await tx.save_user(user)
            for session in await tx.sessions(user.id):
                session.revoked_at = datetime.now(UTC)
                await tx.save_session(session)
            await tx.audit(user.id, "account.password-changed", user.id, {})
