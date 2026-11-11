"""登录、刷新、撤销与初始化用例，事务中重复检查当前身份。"""

import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import (
    MEMBER_PERMISSIONS,
    PERMISSIONS,
    Account,
    LoginSession,
    Role,
    User,
)
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
            for role_id, grants in (
                ("admin", list(PERMISSIONS)),
                ("member", list(MEMBER_PERMISSIONS)),
            ):
                if role_id not in existing:
                    await tx.save_role(Role(role_id, role_id, "", grants, builtin=True))

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

    async def role_choices(self, account: Account) -> list[dict[str, str]]:
        """菜单配置只读取角色标识/名称，不跨模块暴露身份表。"""
        account.require("menus.read" if "menus.read" in account.permissions else "menus.manage")
        async with self.repository.transaction() as tx:
            return [{"id": role.id, "name": role.name} for role in await tx.roles()]

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
