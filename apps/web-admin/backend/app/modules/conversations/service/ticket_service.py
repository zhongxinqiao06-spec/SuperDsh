"""WebSocket 票据绑定登录会话、客户端与作用域并只允许消费一次。"""

import secrets
from datetime import UTC, datetime, timedelta

from app.infrastructure.crypto import CredentialCipher, digest
from app.infrastructure.errors import DomainError
from app.modules.conversations.dao.conversation_dao import ConversationRepository
from app.modules.conversations.entity.do.models import WebSocketTicketRow
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.identity import IdentityService


class TicketService:
    def __init__(
        self,
        repository: ConversationRepository,
        identity: IdentityService,
        cipher: CredentialCipher,
    ) -> None:
        self.repository, self.identity, self.cipher = repository, identity, cipher

    async def issue(
        self, account: Account, access: str, client_id: str, scope: dict[str, object]
    ) -> dict[str, object]:
        """保存加密访问凭据以便长连接重新验证原登录会话。"""
        if scope == {"dashboard": True}:
            account.require("devices.read")
        elif set(scope) == {"sessionId"} and isinstance(scope["sessionId"], str):
            account.require("sessions.read")
            async with self.repository.transaction() as dao:
                row = await dao.session(scope["sessionId"])
                if not row or row.owner_id != account.user_id or row.source.get("historyDeletedAt"):
                    raise DomainError(404, "session not found")
        else:
            raise DomainError(422, "invalid socket scope")
        ticket = secrets.token_urlsafe(32)
        identifier = digest(ticket)
        now = datetime.now(UTC)
        expires = now + timedelta(seconds=60)
        async with self.repository.transaction() as dao:
            await dao.save(
                WebSocketTicketRow(
                    digest=identifier,
                    access_token=self.cipher.seal(access, identifier),
                    owner_id=account.user_id,
                    client_id=client_id,
                    scope=scope,
                    expires_at=expires,
                )
            )
        return {"ticket": ticket, "expiresAt": expires.isoformat(), "serverTime": now.isoformat()}

    async def consume(
        self, ticket: str, client: str, scope: dict[str, object]
    ) -> tuple[Account, str, str]:
        """消费与删除在同一锁内，验证失败不泄露有效票据内容。"""
        identifier = digest(ticket)
        async with self.repository.transaction() as dao:
            await dao.lock("ticket:" + identifier)
            row = await dao.ticket(identifier)
            valid = bool(
                row
                and row.expires_at > datetime.now(UTC)
                and (not client or row.client_id == client)
                and row.scope == scope
            )
            token = self.cipher.open(row.access_token, identifier) if row and valid else ""
            owner = row.owner_id if row else ""
            client_id = row.client_id if row else ""
            if row:
                # 错作用域也消费票据；不能在回滚事务后恢复已尝试的凭据。
                await dao.remove(row)
        if not valid:
            raise DomainError(401, "invalid WebSocket ticket")
        account = await self.identity.authenticate(token)
        if account.user_id != owner:
            raise DomainError(401, "invalid ticket owner")
        account.require("devices.read" if scope == {"dashboard": True} else "sessions.read")
        return account, token, client_id
