"""持久邮箱验证码：限流和尝试次数落库，发送在短事务外并具有超时。"""

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Protocol

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.dao.account_dao import SqlAccountRepository
from app.modules.identity.entity.do.account_models import VerificationCodeRow, VerificationLimitRow


class MailSender(Protocol):
    """真实邮件传输可替换为隔离测试接收器；禁止在测试中向用户邮箱发信。"""

    async def send(self, configuration: dict[str, object], address: str, code: str) -> None: ...


class ResendMailSender:
    async def send(self, configuration: dict[str, object], address: str, code: str) -> None:
        async with httpx.AsyncClient(timeout=15) as client:
            result = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {configuration['apiKey']}"},
                json={
                    "from": configuration["fromAddress"],
                    "to": [address],
                    "subject": "SuperDsh · 邮箱验证码 / Email verification",
                    "text": f"你的 SuperDsh 邮箱验证码是：{code}\nYour SuperDsh verification code is: {code}\n验证码 10 分钟内有效，请勿分享。",
                },
            )
            result.raise_for_status()
            if not result.json().get("id"):
                raise ValueError("delivery rejected")


class EmailVerification:
    """同一邮箱的请求跨进程串行，OTP 仅保存带服务端密钥的摘要。"""

    def __init__(
        self, repository: SqlAccountRepository, secret: str, sender: MailSender | None = None
    ) -> None:
        self.repository, self.secret, self.sender = repository, secret, sender or ResendMailSender()

    def scope(self, address: str, purpose: str, user_id: str) -> str:
        return hashlib.sha256(f"{address}\0{purpose}\0{user_id}".encode()).hexdigest()

    def digest(self, nonce: str, code: str) -> str:
        return hmac.new(
            self.secret.encode(), f"email-code:{nonce}:{code}".encode(), hashlib.sha256
        ).hexdigest()

    async def consume(
        self, session: AsyncSession, address: str, purpose: str, user_id: str, code: str
    ) -> bool:
        """错误尝试也必须提交计数；调用方在事务退出之后再抛出校验失败。"""
        row = await self.repository.code(session, self.scope(address, purpose, user_id))
        now = datetime.now(UTC)
        if not row or row.consumed_at or row.expires_at <= now or row.attempts >= 5:
            return False
        if not hmac.compare_digest(row.code_hash, self.digest(row.nonce, code)):
            row.attempts += 1
            return False
        row.consumed_at = now
        return True

    async def issue(
        self, configuration: dict[str, object], address: str, purpose: str, user_id: str
    ) -> None:
        if (
            not configuration.get("enabled")
            or not configuration.get("apiKey")
            or not configuration.get("fromAddress")
        ):
            raise DomainError(409, "email verification is disabled")
        now, scope = datetime.now(UTC), self.scope(address, purpose, user_id)
        code, nonce = f"{secrets.randbelow(1000000):06d}", secrets.token_urlsafe(24)
        async with self.repository.sessions.begin() as session:
            await lock_transaction(
                session, "email-code:" + hashlib.sha256(address.encode()).hexdigest()
            )
            limit = await self.repository.email_limit(
                session, hashlib.sha256(address.encode()).hexdigest()
            )
            if limit and limit.started_at > now - timedelta(hours=1) and limit.count >= 10:
                raise DomainError(429, "too many verification emails; try again later")
            row = await self.repository.code(session, scope)
            if row and row.sent_at > now - timedelta(seconds=60):
                raise DomainError(429, "wait 60 seconds before requesting another code")
            if row and row.attempts >= 5 and row.sent_at > now - timedelta(hours=1):
                raise DomainError(429, "too many incorrect codes; try again later")
            if not limit:
                limit = VerificationLimitRow(
                    key=hashlib.sha256(address.encode()).hexdigest(), started_at=now, count=0
                )
                session.add(limit)
            if limit.started_at <= now - timedelta(hours=1):
                limit.started_at, limit.count = now, 0
            limit.count += 1
            await session.merge(
                VerificationCodeRow(
                    scope=scope,
                    nonce=nonce,
                    code_hash=self.digest(nonce, code),
                    sent_at=now,
                    expires_at=now + timedelta(minutes=10),
                    consumed_at=None,
                    attempts=row.attempts if row and row.sent_at > now - timedelta(hours=1) else 0,
                )
            )
        try:
            await self.sender.send(configuration, address, code)
        except Exception as error:
            async with self.repository.sessions.begin() as session:
                current = await self.repository.code(session, scope)
                if current and current.code_hash == self.digest(nonce, code):
                    current.consumed_at = datetime.now(UTC)
            raise DomainError(502, "verification email could not be sent") from error
