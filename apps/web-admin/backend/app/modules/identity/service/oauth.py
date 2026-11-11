"""OAuth 授权码与 PKCE 服务，沿用已有客户端身份和回调白名单。"""

import base64
import hashlib
import re
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.oauth import OAuthGrant

from .identity import IdentityService, Login
from .ports import OAuthRepository


def allowed_redirect(client: str, uri: str) -> bool:
    """保留原桌面随机回环端口及移动端 scheme，不宽泛允许任意地址。"""
    if client in {"superdsh-desktop", "agents-anywhere-dsh-plugin"}:
        match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/oauth/callback", uri)
        return bool(match and 1024 <= int(match[1]) <= 65535)
    return (client == "agents-anywhere-mobile" and uri == "agents-anywhere://oauth/callback") or (
        client == "agents-anywhere-desktop" and uri == "agents-anywhere-desktop://oauth/callback"
    )


class OAuthService:
    """产品作为 OAuth server 的本地可验证闭环；外部 IdP 联调另行配置。"""

    def __init__(self, repository: OAuthRepository, identity: IdentityService) -> None:
        self.repository, self.identity = repository, identity

    async def authorize(
        self,
        account: Account,
        client: str,
        uri: str,
        challenge: str,
        method: str,
        response_type: str,
        state: str,
        scope: str,
    ) -> str:
        """代码只保存摘要；原始回调身份不经过兼容入口改写。"""
        if account.reset_required:
            raise DomainError(403, "password change required")
        if response_type != "code":
            raise DomainError(422, "response_type must be code")
        if not allowed_redirect(client, uri):
            raise DomainError(422, "redirect uri is not allowed")
        if method != "S256" or not re.fullmatch(r"[A-Za-z0-9_-]{43}", challenge):
            raise DomainError(422, "code challenge method must be S256")
        code = secrets.token_urlsafe(32)
        async with self.repository.transaction() as tx:
            await tx.save(
                OAuthGrant(
                    self.identity.security.hash_token(code),
                    account.user_id,
                    account.session_id,
                    account.auth_version,
                    client,
                    uri,
                    challenge,
                    datetime.now(UTC) + timedelta(minutes=5),
                    scope,
                )
            )
        query = {"code": code}
        if state:
            query["state"] = state
        return uri + "?" + urlencode(query)

    async def exchange(self, code: str, client: str, uri: str, verifier: str) -> tuple[Login, str]:
        """校验原会话仍有效、PKCE 和回调，重复兑换明确失败。"""
        if not allowed_redirect(client, uri) or not re.fullmatch(
            r"[A-Za-z0-9._~-]{43,128}", verifier
        ):
            raise DomainError(400, "invalid authorization code or verifier")
        hashed = self.identity.security.hash_token(code)
        async with self.repository.transaction() as tx:
            grant = await tx.read(hashed)
        if grant is None or grant.consumed_at or grant.expires_at <= datetime.now(UTC):
            raise DomainError(400, "authorization grant expired or revoked")
        try:
            account = await self.identity.authenticate(
                self.identity.security.issue(grant.user_id, grant.session_id, grant.auth_version)
            )
            if account.reset_required:
                raise DomainError(403, "password change required")
        except DomainError as error:
            raise DomainError(400, "authorization grant expired or revoked") from error
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .decode()
            .rstrip("=")
        )
        async with self.repository.transaction() as tx:
            accepted = await tx.read(hashed, lock=True)
            if (
                accepted is None
                or accepted.consumed_at
                or accepted.expires_at <= datetime.now(UTC)
                or accepted.client_id != client
                or accepted.redirect_uri != uri
                or accepted.challenge != challenge
            ):
                raise DomainError(400, "invalid authorization code or verifier")
            accepted.consumed_at = datetime.now(UTC)
            await tx.save(accepted)
        return await self.identity.issue_login(
            accepted.user_id, client, expected_version=accepted.auth_version
        ), accepted.scope
