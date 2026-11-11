"""完整账户用例：资料、受控注册、邮箱及一次性恢复码，不改变现有认证事实源。"""

import secrets
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.infrastructure.crypto import PasswordSecurity
from app.infrastructure.database import lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.dao.account_dao import SqlAccountRepository
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.validation import (
    account_username,
    collision_username,
    display_name,
    email_address,
)
from app.modules.identity.entity.do.account_models import RecoveryCodeRow
from app.modules.identity.entity.do.models import UserRow
from app.modules.identity.entity.vo.account_vo import EmailCodeInput, EmailInput, RecoveryInput
from app.modules.identity.entity.vo.dto import RegisterInput, account_payload
from app.modules.identity.service.email_service import EmailVerification
from app.modules.identity.service.external_oauth_service import ExternalOAuth
from app.modules.identity.service.identity import IdentityService
from app.modules.identity.service.mobile_service import MobileLogin
from app.modules.management.service.system_service import SystemManagement


def object_value(value: object) -> dict[str, object]:
    """只接收明确对象，避免设置中的错误值变成宽泛隐式转换。"""
    return dict(value) if isinstance(value, dict) else {}


class AccountFlows:
    """业务输入经 VO 校验，数据库变更与授权代际更新由短事务持有。"""

    def __init__(
        self,
        repository: SqlAccountRepository,
        identity: IdentityService,
        system: SystemManagement,
        security: PasswordSecurity,
    ) -> None:
        self.repository, self.identity, self.system, self.security = (
            repository,
            identity,
            system,
            security,
        )
        self.email = EmailVerification(repository, security.secret)
        self.mobile = MobileLogin(repository, identity)
        self.external = ExternalOAuth(self)

    async def configuration(self) -> dict[str, object]:
        settings = await self.system.internal_settings()
        oauth = object_value(settings.get("oauth"))
        enabled = bool(oauth.get("enabled") and oauth.get("authorizeUrl") and oauth.get("clientId"))
        bootstrap = await self.identity.needs_bootstrap()
        return {
            "needsBootstrap": bootstrap,
            "registrationOpen": bool(settings.get("registrationOpen")),
            "oauthRegistrationOpen": bool(settings.get("oauthRegistrationOpen")),
            "oauthEnabled": enabled,
            "oauthProviderLabel": oauth.get("label", "OAuth") if enabled else None,
            "emailVerificationRequired": bool(object_value(settings.get("email")).get("enabled")),
            "setupTokenExpiresAt": self.identity.setup_expires_at.isoformat()
            if bootstrap
            and self.identity.setup_token
            and self.identity.setup_expires_at.timestamp() > 0
            else None,
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def current(self, account: Account) -> Account:
        return await self.identity.authenticate(
            self.security.issue(account.user_id, account.session_id, account.auth_version)
        )

    async def profile(self, account: Account, changes: dict[str, object]) -> dict[str, object]:
        """本人资料更新不隐式变更角色或密钥，唯一性冲突由数据库统一映射 409。"""
        async with self.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:identity-management")
            await self.current(account)
            user = await self.repository.user(session, account.user_id, by_id=True)
            if user is None:
                raise DomainError(404, "user not found")
            for name in ("display_name", "username", "avatar_url"):
                if name in changes:
                    setattr(user, name, changes[name])
            user.revision += 1
        await self.identity.audit(
            account.user_id, "account.profile-updated", account.user_id, {"fields": list(changes)}
        )
        return account_payload(await self.current(account))

    async def register(self, body: RegisterInput, *, oauth_registration: bool = False) -> Account:
        settings = await self.system.internal_settings()
        if not settings.get("oauthRegistrationOpen" if oauth_registration else "registrationOpen"):
            raise DomainError(403, "registration is closed")
        username = account_username(body.username, body.email)
        email_settings = object_value(settings.get("email"))
        if email_settings.get("enabled") and not body.email:
            raise DomainError(422, "email is required")
        hashed = await self.security.hash_password(
            body.password, body.passwordVerifier, body.passwordSalt
        )
        verified = True
        user_id = str(uuid4())
        async with self.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:identity-management")
            if not body.username and body.email and await self.repository.user(session, username):
                username = collision_username(username, body.email)
            if await self.repository.user(session, username) or (
                body.email and await self.repository.user(session, body.email)
            ):
                raise DomainError(409, "username or email is already in use")
            if email_settings.get("enabled"):
                verified = await self.email.consume(
                    session, body.email or "", "register", "", body.code
                )
            if verified:
                session.add(
                    UserRow(
                        id=user_id,
                        username=username,
                        password_hash=hashed,
                        roles=["member"],
                        email=body.email,
                        display_name=display_name(body.displayName),
                        disabled=False,
                        reset_required=False,
                        auth_version=0,
                        revision=1,
                        created_at=datetime.now(UTC),
                        email_verified_at=datetime.now(UTC) if body.email else None,
                    )
                )
        if not verified:
            raise DomainError(422, "invalid or expired verification code")
        await self.identity.audit(user_id, "account.registered", user_id, {})
        # 不创建额外登录会话；调用者使用标准 issue_login 发放一次登录。
        async with self.identity.repository.transaction() as tx:
            from app.modules.identity.service.identity import resolve_account

            user = await tx.user(user_id)
            if user is None:
                raise DomainError(500, "account creation failed")
            return await resolve_account(tx, user)

    async def recovery_codes(self, account: Account) -> dict[str, object]:
        """恢复码只在本次响应中出现，替换后旧码立即失效。"""
        values = [secrets.token_urlsafe(24) for _ in range(8)]
        async with self.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:identity-management")
            await self.current(account)
            await self.repository.replace_recovery(
                session,
                account.user_id,
                [
                    RecoveryCodeRow(
                        code_hash=self.security.hash_token(value),
                        user_id=account.user_id,
                        created_at=datetime.now(UTC),
                    )
                    for value in values
                ],
            )
        await self.identity.audit(
            account.user_id, "account.recovery-codes-created", account.user_id, {}
        )
        return {"codes": values}

    async def reset_password(self, body: RecoveryInput, *, email: bool = False) -> None:
        """消费凭据和改密原子提交，失败尝试计数提交但不能修改密码。"""
        identifier = email_address(body.email) if email else body.identifier.strip().lower()
        if not identifier:
            raise DomainError(422, "login identifier is required")
        hashed = await self.security.hash_password(
            body.newPassword, body.newPasswordVerifier, body.newPasswordSalt
        )
        valid = False
        async with self.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:identity-management")
            user = await self.repository.user(session, identifier)
            if not user or user.disabled or user.deleted_at:
                raise DomainError(401, "invalid recovery credentials")
            if email:
                valid = bool(user.email_verified_at) and await self.email.consume(
                    session, user.email or "", "reset", user.id, body.code
                )
            else:
                code = await self.repository.recovery(
                    session, self.security.hash_token(body.recoveryCode)
                )
                valid = bool(code and code.user_id == user.id and not code.consumed_at)
                if valid and code:
                    code.consumed_at = datetime.now(UTC)
            if valid:
                user.password_hash, user.reset_required = hashed, False
                user.auth_version += 1
                user.revision += 1
                await self.repository.revoke_sessions(session, user.id, datetime.now(UTC))
        if not valid:
            raise DomainError(401, "invalid recovery credentials")
        await self.identity.audit(user.id, "account.password-recovered", user.id, {})

    async def issue_email(self, body: EmailCodeInput, account: Account | None) -> dict[str, object]:
        body.email = email_address(body.email)
        if body.purpose not in {"register", "bind", "reset"}:
            raise DomainError(422, "invalid email verification purpose")
        settings = await self.system.internal_settings()
        if body.purpose == "bind" and not account:
            raise DomainError(401, "authentication required")
        if (
            body.purpose == "register"
            and not settings.get("registrationOpen")
            and not (account and "admin" in account.roles)
        ):
            # 仅既有空库兼容初始化可使用有效setup token；已有账号时绝不绕过注册开关。
            bootstrap_allowed = False
            if body.setupToken and await self.identity.needs_bootstrap():
                try:
                    self.identity.validate_setup_token(body.setupToken)
                    bootstrap_allowed = True
                except DomainError:
                    pass
            if not bootstrap_allowed and (
                not body.pendingToken or not settings.get("oauthRegistrationOpen")
            ):
                raise DomainError(403, "registration is closed")
            if not bootstrap_allowed:
                await self.external.pending(body.pendingToken)
        async with self.repository.sessions() as session:
            user = await self.repository.user(session, body.email)
            if body.purpose == "reset" and (
                not user or user.disabled or user.deleted_at or not user.email_verified_at
            ):
                return {"serverTime": datetime.now(UTC).isoformat()}
            if body.purpose != "reset" and user and (not account or user.id != account.user_id):
                raise DomainError(409, "email is already in use")
            owner = (
                user.id
                if body.purpose == "reset" and user
                else account.user_id
                if body.purpose == "bind" and account
                else ""
            )
        await self.email.issue(object_value(settings.get("email")), body.email, body.purpose, owner)
        return {"serverTime": datetime.now(UTC).isoformat()}

    async def bind_email(self, account: Account, body: EmailInput) -> dict[str, object]:
        settings = await self.system.internal_settings()
        valid = True
        async with self.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:identity-management")
            await self.current(account)
            if object_value(settings.get("email")).get("enabled"):
                valid = await self.email.consume(
                    session, body.email, "bind", account.user_id, body.code
                )
            user = await self.repository.user(session, account.user_id, by_id=True)
            if not user:
                raise DomainError(404, "user not found")
            if valid:
                user.email, user.email_verified_at = body.email, datetime.now(UTC)
                user.revision += 1
        if not valid:
            raise DomainError(422, "invalid or expired verification code")
        return account_payload(await self.current(account))

    async def audit_page(
        self, account: Account, page: int, size: int, search: str, action: str
    ) -> dict[str, object]:
        account.require("audit.read")
        async with self.repository.sessions() as session:
            rows, total = await self.repository.audit_page(session, page, size, search, action)
        return {
            "events": [
                {
                    "id": row.id,
                    "actorId": row.actor_id,
                    "actorUsername": username,
                    "action": row.action,
                    "targetId": row.target_id,
                    "detail": row.detail,
                    "createdAt": row.created_at.isoformat(),
                }
                for row, username in rows
            ],
            "total": total,
            "page": page,
            "pageSize": size,
        }

    async def facts(
        self, account: Account, from_date: str, to_date: str, zone: str
    ) -> dict[str, object]:
        """总览只读取身份域已持久化事实，不触发设备扫描或 Agent 生命周期。"""
        from zoneinfo import ZoneInfo

        account.require("settings.manage")
        start = datetime.fromisoformat(from_date).replace(tzinfo=ZoneInfo(zone))
        end = datetime.fromisoformat(to_date).replace(tzinfo=ZoneInfo(zone)) + timedelta(days=1)
        async with self.repository.sessions() as session:
            users, logins = await self.repository.facts(session, end)
            return {
                "users": [
                    {
                        "userId": user.id,
                        "createdAt": user.created_at.isoformat() if user.created_at else None,
                    }
                    for user in users
                ],
                "logins": [
                    {
                        "userId": value.user_id,
                        "createdAt": (value.last_seen_at or value.created_at).isoformat(),
                    }
                    for value in logins
                    if (value.last_seen_at or value.created_at) >= start - timedelta(days=30)
                ],
            }
