"""可配置外部 OAuth：PKCE、浏览器绑定、一次性回调和显式账户绑定。"""

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from app.infrastructure.crypto import encode
from app.infrastructure.database import lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.do.account_models import (
    ExternalOAuthBindingRow,
    ExternalOAuthStateRow,
)
from app.modules.identity.entity.vo.account_vo import OAuthFinalizeInput
from app.modules.identity.entity.vo.dto import RegisterInput
from app.modules.identity.service.identity import Login

if TYPE_CHECKING:
    from app.modules.identity.service.account_service import AccountFlows


class ExternalOAuth:
    """HTTP transport 可注入测试接收器；生产只访问管理员配置的身份服务。"""

    def __init__(self, accounts: "AccountFlows") -> None:
        self.accounts = accounts
        self.transport: httpx.AsyncBaseTransport | None = None

    async def configuration(self) -> dict[str, object]:
        value = (await self.accounts.system.internal_settings()).get("oauth")
        config = dict(value) if isinstance(value, dict) else {}
        if not config.get("enabled"):
            raise DomainError(404, "oauth is not configured")
        return config

    async def save_state(self, kind: str, value: dict[str, object]) -> str:
        token = secrets.token_urlsafe(48)
        async with self.accounts.repository.sessions.begin() as session:
            session.add(
                ExternalOAuthStateRow(
                    token_hash=self.accounts.security.hash_token(token),
                    kind=kind,
                    value=value,
                    expires_at=datetime.now(UTC) + timedelta(minutes=10),
                )
            )
        return token

    async def start(self, return_to: str, callback: str) -> tuple[str, str]:
        config = await self.configuration()
        target = urlsplit(return_to or self.accounts.system.public_origin + "/login")
        allowed = {
            urlsplit(value).scheme + "://" + urlsplit(value).netloc
            for value in self.accounts.system.allowed_origins
        }
        if (
            target.scheme + "://" + target.netloc not in allowed
            or target.username
            or target.password
        ):
            raise DomainError(422, "OAuth return address must use the public origin")
        verifier = secrets.token_urlsafe(48)
        token = await self.save_state(
            "state",
            {
                "returnTo": urlunsplit(target),
                "callback": callback,
                "provider": str(config.get("provider") or "oidc"),
                "verifier": verifier,
            },
        )
        url = urlsplit(str(config.get("authorizeUrl") or ""))
        params = dict(parse_qsl(url.query))
        params.update(
            client_id=str(config.get("clientId") or ""),
            redirect_uri=callback,
            response_type="code",
            scope=str(config.get("scopes") or config.get("scope") or "openid profile email"),
            state=token,
            code_challenge=encode(hashlib.sha256(verifier.encode()).digest()),
            code_challenge_method="S256",
        )
        return urlunsplit(
            (url.scheme, url.netloc, url.path, urlencode(params), url.fragment)
        ), token

    async def callback(self, state: str, cookie: str, code: str, provider_error: str) -> str:
        """先消费回调状态再发网络请求，刷新页面不能重复交换提供方授权码。"""
        config = await self.configuration()
        async with self.accounts.repository.sessions.begin() as session:
            row = await self.accounts.repository.oauth_state(
                session, self.accounts.security.hash_token(state)
            )
            if (
                not row
                or row.kind != "state"
                or row.consumed_at
                or row.expires_at <= datetime.now(UTC)
                or not hmac.compare_digest(cookie, self.accounts.security.hash_token(state))
            ):
                raise DomainError(401, "invalid OAuth callback state")
            row.consumed_at = datetime.now(UTC)
            value = dict(row.value)
        if value.get("provider") != str(config.get("provider") or "oidc"):
            raise DomainError(401, "OAuth provider changed during authorization")
        target = urlsplit(str(value["returnTo"]))
        params = dict(parse_qsl(target.query))
        try:
            if provider_error or not code:
                raise DomainError(401, "OAuth provider rejected authorization")
            async with httpx.AsyncClient(
                timeout=10, follow_redirects=False, transport=self.transport
            ) as client:
                response = await client.post(
                    str(config["tokenUrl"]),
                    data={
                        "grant_type": "authorization_code",
                        "code": code,
                        "redirect_uri": str(value["callback"]),
                        "client_id": str(config["clientId"]),
                        "client_secret": str(config.get("clientSecret") or ""),
                        "code_verifier": str(value["verifier"]),
                    },
                    headers={"Accept": "application/json"},
                )
                response.raise_for_status()
                token_response = response.json()
                if not isinstance(token_response, dict):
                    raise ValueError("invalid provider token response")
                access = token_response.get("access_token")
                if not isinstance(access, str) or not access:
                    raise ValueError("missing provider access token")
                response = await client.get(
                    str(config["userInfoUrl"]),
                    headers={"Authorization": f"Bearer {access}", "Accept": "application/json"},
                )
                response.raise_for_status()
                claims = response.json()
                if not isinstance(claims, dict):
                    raise ValueError("invalid provider claims response")
            subject = claims.get(str(config.get("subjectClaim") or "sub"))
            if not isinstance(subject, str) or not subject or len(subject) > 2048:
                raise ValueError("invalid provider subject")
            provider = str(config.get("provider") or "oidc")
            address = str(claims.get(str(config.get("emailClaim") or "email")) or "").lower()
            name = str(claims.get(str(config.get("nameClaim") or "name")) or "")
            pending = await self.save_state(
                "pending",
                {"provider": provider, "subject": subject, "email": address, "displayName": name},
            )
            async with self.accounts.repository.sessions() as session:
                bound = await self.accounts.repository.oauth_binding(
                    session, self.binding_key(provider, subject)
                )
                existing = (
                    await self.accounts.repository.user(session, address) if address else None
                )
            params.update(
                oauth_status="authenticated"
                if bound
                else "needs_password"
                if existing
                else "needs_registration",
                oauth_pending=pending,
                oauth_email=address,
                oauth_display_name=name,
            )
        except (httpx.HTTPError, ValueError, KeyError, TypeError, DomainError):
            params["oauth_error"] = "OAuth provider request failed; check configuration and retry"
        return urlunsplit(
            (target.scheme, target.netloc, target.path, urlencode(params), target.fragment)
        )

    @staticmethod
    def binding_key(provider: str, subject: str) -> str:
        return hashlib.sha256(f"{provider}\0{subject}".encode()).hexdigest()

    async def pending(self, token: str) -> dict[str, object]:
        if not token:
            raise DomainError(401, "oauth session expired")
        async with self.accounts.repository.sessions() as session:
            row = await self.accounts.repository.oauth_state(
                session, self.accounts.security.hash_token(token)
            )
            if (
                not row
                or row.kind != "pending"
                or row.consumed_at
                or row.expires_at <= datetime.now(UTC)
            ):
                raise DomainError(401, "oauth session expired")
            return dict(row.value)

    async def finalize(self, body: OAuthFinalizeInput) -> Login:
        """同一外部身份串行完成，避免并发注册产生未绑定的孤立账户。"""
        value = await self.pending(body.pendingToken)
        key = self.binding_key(str(value["provider"]), str(value["subject"]))
        async with self.accounts.repository.sessions.begin() as gate:
            await lock_transaction(gate, "oauth-finalize:" + key)
            return await self.complete(body)

    async def complete(self, body: OAuthFinalizeInput) -> Login:
        """现有邮箱必须验证密码，不能凭第三方声称的邮箱自动接管账户。"""
        value = await self.pending(body.pendingToken)
        key = self.binding_key(str(value["provider"]), str(value["subject"]))
        async with self.accounts.repository.sessions() as session:
            binding = await self.accounts.repository.oauth_binding(session, key)
            existing = await self.accounts.repository.user(
                session, body.identifier or body.email or str(value.get("email") or "")
            )
            owner = binding.user_id if binding else None
        if not owner and existing:
            if (
                existing.disabled
                or existing.deleted_at
                or not await self.accounts.security.verify(
                    existing.password_hash, body.password, body.passwordVerifier
                )
            ):
                raise DomainError(401, "password is required to link this account")
            owner = existing.id
        if not owner:
            # 旧OAuth注册表单仅提供邮箱和显示名称，用户名沿统一注册规则推导。
            created = await self.accounts.register(
                RegisterInput(
                    username=body.username,
                    displayName=body.displayName or str(value.get("displayName") or ""),
                    email=body.email or str(value.get("email") or "") or None,
                    password=body.password if body.setPassword else secrets.token_urlsafe(48),
                    passwordVerifier=body.passwordVerifier if body.setPassword else None,
                    passwordSalt=body.passwordSalt,
                    code=body.code,
                ),
                oauth_registration=True,
            )
            owner = created.user_id
        async with self.accounts.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:identity-management")
            row = await self.accounts.repository.oauth_state(
                session, self.accounts.security.hash_token(body.pendingToken)
            )
            if not row or row.consumed_at or row.expires_at <= datetime.now(UTC):
                raise DomainError(401, "OAuth session expired")
            binding = await self.accounts.repository.oauth_binding(session, key)
            if binding and binding.user_id != owner:
                raise DomainError(409, "OAuth identity is already linked")
            if not binding:
                session.add(
                    ExternalOAuthBindingRow(
                        key=key,
                        provider=str(value["provider"]),
                        subject=str(value["subject"]),
                        user_id=owner,
                    )
                )
            row.consumed_at = datetime.now(UTC)
        await self.accounts.identity.audit(
            owner, "account.oauth-login", owner, {"provider": value["provider"]}
        )
        return await self.accounts.identity.issue_login(owner, "OAuth Browser")
