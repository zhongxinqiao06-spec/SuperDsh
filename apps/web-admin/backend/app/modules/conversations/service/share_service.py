"""会话分享冻结公开快照，公开端无法回查运行上下文或任意文件。"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.do.models import ConversationShareRow
from app.modules.conversations.service.projection_service import record
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.conversations.service.conversation_service import ConversationService


def attachment_ids(value: object) -> set[str]:
    """只提取已展示文件身份，不把路径、外部 URL 或签名凭据作为分享授权。"""
    found: set[str] = set()
    if isinstance(value, dict):
        identity = value.get("fileId")
        if isinstance(identity, str):
            found.add(identity)
        for nested in value.values():
            found.update(attachment_ids(nested))
    elif isinstance(value, list):
        for nested in value:
            found.update(attachment_ids(nested))
    return found


class ShareService:
    def __init__(self, conversations: ConversationService) -> None:
        self.conversations = conversations

    async def listing(self, account: Account, session_id: str) -> dict[str, object]:
        """登录用户可管理自己分享的生命周期，不返回另一账号的公开身份。"""
        await self.conversations.own(account, session_id, "sessions.run")
        async with self.conversations.repository.transaction() as dao:
            rows = await dao.shares(account.user_id, session_id)
        return {
            "items": [
                {
                    "id": row.id,
                    "url": f"/share/{row.id}",
                    "createdAt": row.created_at.isoformat(),
                    "revokedAt": row.revoked_at.isoformat() if row.revoked_at else None,
                }
                for row in rows
            ]
        }

    async def create(
        self,
        account: Account,
        identifier: str,
        value: dict[str, object] | None = None,
        public_origin: str = "",
    ) -> dict[str, object]:
        row = await self.conversations.own(account, identifier, "sessions.read")
        scope = (value or {}).get("scope", "session")
        identifiers = (value or {}).get("itemIds", [])
        if not isinstance(scope, str) or scope not in {"session", "message"}:
            raise DomainError(422, "invalid share scope")
        await self.conversations.projection.sync(account)
        async with self.conversations.repository.transaction() as dao:
            items = [entry.payload for entry in await dao.snapshot_items(identifier)]
        if scope == "message":
            if not isinstance(identifiers, list) or not all(
                isinstance(item, str) for item in identifiers
            ):
                raise DomainError(422, "invalid share items")
            items = [item for item in items if item.get("id") in identifiers]
            if len(items) != len(identifiers) or any(
                item.get("type") != "message" or item.get("role") != "assistant" for item in items
            ):
                raise DomainError(422, "a reply share must contain existing assistant messages")
        if not items:
            raise DomainError(422, "a reply share must contain existing assistant messages")
        timeline = {"items": items, "hasMore": False, "nextSeq": None}
        identifier = "share_" + secrets.token_urlsafe(24)
        snapshot = {
            "session": {
                "id": row.id,
                "title": row.title,
                "runtime": row.runtime_type,
                "runtimeName": row.source.get("runtimeName"),
                "cwd": row.cwd or None,
            },
            "timeline": timeline,
            "scope": scope,
            "fileIds": sorted(attachment_ids(timeline)),
        }
        now = datetime.now(UTC)
        async with self.conversations.repository.transaction() as dao:
            await dao.lock(row.id)
            current = await dao.session(row.id)
            if not current or current.source.get("historyDeletedAt"):
                raise DomainError(404, "session not found")
            await dao.save(
                ConversationShareRow(
                    id=identifier,
                    owner_id=account.user_id,
                    session_id=row.id,
                    snapshot=snapshot,
                    created_at=now,
                )
            )
        return {
            "share": {
                "id": identifier,
                "url": f"/share/{identifier}",
                "createdAt": now.isoformat(),
            },
            "shareId": identifier,
            "sharePath": f"/share/{identifier}",
            "shareUrl": f"{public_origin.rstrip('/')}/share/{identifier}",
            "scope": scope,
            "createdAt": now.isoformat(),
        }

    async def get(self, identifier: str) -> dict[str, object]:
        async with self.conversations.repository.transaction() as dao:
            row = await dao.share(identifier)
        if not row or row.revoked_at:
            raise DomainError(404, "share not found")
        await self._active_owner(row.owner_id)
        return {
            "share": {"id": row.id, "createdAt": row.created_at.isoformat()},
            "session": row.snapshot.get("session"),
            "timeline": row.snapshot.get("timeline"),
            "shareId": row.id,
            "scope": row.snapshot.get("scope", "session"),
            "items": record(row.snapshot.get("timeline")).get("items", []),
            "createdAt": row.created_at.isoformat(),
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def _active_owner(self, owner: str) -> None:
        """分享是公开读取能力，原账号被禁用或删除后同样应立即撤销。"""
        try:
            await self.conversations.devices.identity.get_account(owner)
        except DomainError as error:
            raise DomainError(404, "share not found") from error

    async def revoke(self, account: Account, identifier: str) -> dict[str, object]:
        account.require("sessions.run")
        async with self.conversations.repository.transaction() as dao:
            await dao.lock("share:" + identifier)
            row = await dao.share(identifier)
            if not row or row.owner_id != account.user_id:
                raise DomainError(404, "share not found")
            row.revoked_at = datetime.now(UTC)
            await dao.save(row)
        return {"revoked": True}

    async def attachment(self, identifier: str, file_id: str) -> tuple[bytes, dict[str, object]]:
        async with self.conversations.repository.transaction() as dao:
            row = await dao.share(identifier)
        allowed = record(row.snapshot).get("fileIds") if row else None
        if not row or row.revoked_at or not isinstance(allowed, list) or file_id not in allowed:
            raise DomainError(404, "file not found")
        await self._active_owner(row.owner_id)
        return await self.conversations.files.read_owned_asset(row.owner_id, file_id)
