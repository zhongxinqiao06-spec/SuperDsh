"""移动扫码登录只授予已确认的账户，一次性状态以数据库为事实源。"""

import secrets
from datetime import UTC, datetime, timedelta

from app.infrastructure.errors import DomainError
from app.modules.identity.dao.account_dao import SqlAccountRepository
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.do.account_models import MobileGrantRow
from app.modules.identity.entity.vo.account_vo import MobileInput
from app.modules.identity.service.identity import IdentityService, Login


class MobileLogin:
    """扫码、网页确认、兑换分离，撤销网页会话同步使未完成授权失效。"""

    def __init__(self, repository: SqlAccountRepository, identity: IdentityService) -> None:
        self.repository, self.identity = repository, identity

    async def create(self, account: Account) -> dict[str, object]:
        if account.reset_required or account.disabled or account.deleted_at:
            raise DomainError(403, "account is not available for mobile login")
        token = secrets.token_urlsafe(48)
        expires = datetime.now(UTC) + timedelta(seconds=120)
        async with self.repository.sessions.begin() as session:
            session.add(
                MobileGrantRow(
                    token_hash=self.identity.security.hash_token(token),
                    user_id=account.user_id,
                    session_id=account.session_id,
                    auth_version=account.auth_version,
                    expires_at=expires,
                )
            )
        return {
            "loginToken": token,
            "userId": account.user_id,
            "expiresAt": expires.isoformat(),
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def operate(
        self, operation: str, body: MobileInput, account: Account | None = None
    ) -> dict[str, object] | Login:
        """同一授权行加锁，重复并发兑换只能有一个请求创建登录会话。"""
        if not body.loginToken:
            raise DomainError(401, "invalid or expired mobile login token")
        now = datetime.now(UTC)
        async with self.repository.sessions.begin() as session:
            row = await self.repository.mobile(
                session, self.identity.security.hash_token(body.loginToken)
            )
            if not row:
                raise DomainError(401, "invalid or expired mobile login token")
            issuer = await self.identity.authenticate(
                self.identity.security.issue(row.user_id, row.session_id, row.auth_version)
            )
            if issuer.reset_required:
                raise DomainError(401, "invalid or expired mobile login token")
            if operation == "confirm" and (not account or account.user_id != row.user_id):
                raise DomainError(401, "invalid or expired mobile login token")
            if operation in {"request", "exchange"} and body.userId != row.user_id:
                raise DomainError(401, "invalid or expired mobile login token")
            if operation != "status" and (row.expires_at <= now or row.consumed_at):
                raise DomainError(401, "invalid or expired mobile login token")
            if operation == "request" and not row.rejected_at:
                row.requested_at = row.requested_at or now
                row.device_name = body.deviceName or None
            elif operation == "confirm" and row.requested_at:
                if body.approved:
                    row.approved_at = now
                    row.rejected_at = None
                else:
                    row.rejected_at = now
                    row.approved_at = None
            elif operation == "exchange":
                if not row.approved_at or row.rejected_at:
                    raise DomainError(401, "mobile login requires approval")
                row.consumed_at = now
            status = (
                "consumed"
                if row.consumed_at
                else "expired"
                if row.expires_at <= now
                else "rejected"
                if row.rejected_at
                else "approved"
                if row.approved_at
                else "pending_web_confirm"
                if row.requested_at
                else "pending_scan"
            )
            result: dict[str, object] = {
                "status": status,
                "userId": row.user_id,
                "deviceName": row.device_name,
                "expiresAt": row.expires_at.isoformat(),
                "requestedAt": row.requested_at.isoformat() if row.requested_at else None,
                "approvedAt": row.approved_at.isoformat() if row.approved_at else None,
                "serverTime": now.isoformat(),
            }
            owner = row.user_id
        if operation == "exchange":
            await self.identity.audit(owner, "account.mobile-login", owner, {})
            return await self.identity.issue_login(owner, "Mobile")
        return result
