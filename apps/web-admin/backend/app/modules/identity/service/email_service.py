"""持久邮箱验证码：限流和尝试次数落库，发送在短事务外并具有超时。"""

import hashlib
import hmac
import math
import secrets
from datetime import UTC, datetime, timedelta
from typing import Protocol

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.dao.account_dao import SqlAccountRepository
from app.modules.identity.entity.do.account_models import VerificationCodeRow, VerificationLimitRow


def wait_error(detail: str, code: str, until: datetime) -> DomainError:
    """服务端给出实际剩余时间，以便刷新和多标签页共享同一限流窗口。"""
    return DomainError(
        429,
        detail,
        code,
        retry_after=max(1, math.ceil((until - datetime.now(UTC)).total_seconds())),
    )


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
        self,
        repository: SqlAccountRepository,
        secret: str,
        sender: MailSender | None = None,
        *,
        registration_sender: MailSender | None = None,
    ) -> None:
        self.repository, self.secret, self.sender = repository, secret, sender or ResendMailSender()
        self.registration_sender = registration_sender

    def available(self, configuration: dict[str, object], purpose: str) -> bool:
        """已审核的注册模板仅用于注册，找回密码和绑邮箱仍使用原有配置。"""
        if purpose == "register" and self.registration_sender is not None:
            return True
        return bool(
            configuration.get("enabled")
            and configuration.get("apiKey")
            and configuration.get("fromAddress")
        )

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
        return await self.consume_error(session, address, purpose, user_id, code) is None

    async def consume_error(
        self, session: AsyncSession, address: str, purpose: str, user_id: str, code: str
    ) -> DomainError | None:
        """事务内返回失败原因，让调用方先提交错误计数，再向客户端返回。"""
        row = await self.repository.code(session, self.scope(address, purpose, user_id))
        detail = "invalid or expired verification code"
        now = datetime.now(UTC)
        if not row or row.consumed_at:
            return DomainError(422, detail, "verification_code_required")
        if row.attempts >= 5:
            return wait_error(
                detail, "verification_attempts_exhausted", row.sent_at + timedelta(hours=1)
            )
        if row.expires_at <= now:
            return DomainError(422, detail, "verification_code_expired")
        if not hmac.compare_digest(row.code_hash, self.digest(row.nonce, code)):
            row.attempts += 1
            if row.attempts >= 5:
                return wait_error(
                    detail, "verification_attempts_exhausted", row.sent_at + timedelta(hours=1)
                )
            return DomainError(422, detail, "verification_code_incorrect")
        row.consumed_at = now
        return None

    async def issue(
        self, configuration: dict[str, object], address: str, purpose: str, user_id: str
    ) -> dict[str, str]:
        if not self.available(configuration, purpose):
            raise DomainError(409, "email verification is disabled", "verification_unavailable")
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
                raise wait_error(
                    "too many verification emails; try again later",
                    "verification_hourly_limit",
                    limit.started_at + timedelta(hours=1),
                )
            row = await self.repository.code(session, scope)
            if row and row.attempts >= 5 and row.sent_at > now - timedelta(hours=1):
                raise wait_error(
                    "too many incorrect codes; try again later",
                    "verification_attempts_exhausted",
                    row.sent_at + timedelta(hours=1),
                )
            if row and row.sent_at > now - timedelta(seconds=60):
                raise wait_error(
                    "wait 60 seconds before requesting another code",
                    "verification_cooldown",
                    row.sent_at + timedelta(seconds=60),
                )
            if not limit:
                limit = VerificationLimitRow(
                    key=hashlib.sha256(address.encode()).hexdigest(), started_at=now, count=0
                )
                session.add(limit)
            if limit.started_at <= now - timedelta(hours=1):
                limit.started_at, limit.count = now, 0
            limit.count += 1
            previous = (
                (row.nonce, row.code_hash, row.expires_at)
                if row and not row.consumed_at and row.expires_at > now
                else None
            )
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
            sender = self.registration_sender if purpose == "register" else None
            await (sender or self.sender).send(configuration, address, code)
        except Exception as error:
            async with self.repository.sessions.begin() as session:
                current = await self.repository.code(session, scope)
                if current and current.nonce == nonce and not current.consumed_at:
                    # 重发失败只撤销本次写入；保留原码有效期、累计错误次数和本次发送的冷却。
                    if previous:
                        current.nonce, current.code_hash, current.expires_at = previous
                    else:
                        current.consumed_at = datetime.now(UTC)
            raise DomainError(
                502,
                "verification email could not be sent",
                "verification_send_failed",
                retry_after=max(
                    1, math.ceil((now + timedelta(seconds=60) - datetime.now(UTC)).total_seconds())
                ),
            ) from error
        return {
            "serverTime": datetime.now(UTC).isoformat(),
            "expiresAt": (now + timedelta(minutes=10)).isoformat(),
            "resendAt": (now + timedelta(seconds=60)).isoformat(),
        }
