"""附件短期下载授权绑定原登录会话，取消授权后派生地址立即失效。"""

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from time import monotonic
from typing import TYPE_CHECKING

from app.infrastructure.crypto import digest
from app.infrastructure.errors import DomainError
from app.infrastructure.input_validation import required_text
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.conversations.service.conversation_service import ConversationService


@dataclass(frozen=True)
class AttachmentAccess:
    """内存只保存摘要索引与原凭据，重启撤销短期地址而不回放操作。"""

    owner: str
    session_id: str
    file_id: str
    credential: str
    expires: float


class AttachmentAccessService:
    """会话授权、附件引用和原身份在签发及每次读取时重复验证。"""

    def __init__(self, conversations: "ConversationService") -> None:
        self.conversations = conversations
        self.accesses: dict[str, AttachmentAccess] = {}

    @staticmethod
    def metadata(session_id: str, entry: dict[str, object]) -> dict[str, object]:
        """只返回旧附件公开字段，存储键和内部目录不能进入响应。"""
        return {
            "fileId": entry["id"],
            "libraryFileId": entry["id"],
            "sessionId": session_id,
            "path": "",
            "name": entry["name"],
            "size": entry["size"],
            "sha256": entry["sha256"],
            "mediaType": entry["mediaType"],
            "origin": "user",
            "createdAt": entry["createdAt"],
        }

    async def read(
        self, account: Account, session_id: str, file_id: str
    ) -> tuple[bytes, dict[str, object]]:
        """已登录下载同时验证会话和文件引用，管理员也不能读取他人附件。"""
        await self.conversations.get_session(account, session_id)
        content, entry = await self.conversations.files.read_bound(
            account, file_id, "session", session_id
        )
        return content, {**self.metadata(session_id, entry), "fileId": file_id}

    async def issue(self, credential: str, session_id: str, file_id: str) -> str:
        """短期地址不包含原访问令牌，每个账号最多持有256个有效地址。"""
        account = await self.conversations.devices.identity.authenticate(credential)
        await self.read(account, session_id, file_id)
        now = monotonic()
        self.accesses = {key: item for key, item in self.accesses.items() if item.expires > now}
        if (
            len(self.accesses) >= 10000
            or sum(item.owner == account.user_id for item in self.accesses.values()) >= 256
        ):
            raise DomainError(429, "too many active file accesses")
        token = secrets.token_urlsafe(32)
        self.accesses[digest(token)] = AttachmentAccess(
            account.user_id, session_id, file_id, credential, now + 300
        )
        return token

    async def download(
        self, token: str, session_id: str, file_id: str
    ) -> tuple[bytes, dict[str, object]]:
        """过期、登出、撤权或文件移除后均拒绝，票据不能跨附件复用。"""
        access = self.accesses.get(digest(token))
        if not access or access.expires <= monotonic():
            self.accesses.pop(digest(token), None)
            raise DomainError(401, "file access expired")
        account = await self.conversations.devices.identity.authenticate(access.credential)
        if account.user_id != access.owner:
            raise DomainError(401, "invalid file access")
        if access.session_id != session_id or access.file_id != file_id:
            raise DomainError(404, "file not found")
        return await self.read(account, session_id, file_id)

    async def upload(
        self, account: Account, session_id: str, name: str, content: bytes, media_type: str
    ) -> dict[str, object]:
        """接纳协议层解码后的文件，持久化仍通过统一文件服务。"""
        name = required_text(name, "attachment name", 512)
        if len(content) > 32 * 1024 * 1024:
            raise DomainError(413, "attachment is too large")
        await self.conversations.get_session(account, session_id)
        entry = await self.conversations.files.ingest(
            account, name, content, media_type, {"kind": "session", "resourceId": session_id}
        )
        return self.metadata(session_id, entry)

    async def bind(self, account: Account, session_id: str, file_id: str) -> dict[str, object]:
        """文件库引用与上传使用同一附件公开视图。"""
        await self.conversations.get_session(account, session_id)
        entry = await self.conversations.files.bind(account, file_id, "session", session_id)
        return {
            "attachment": self.metadata(session_id, entry),
            "serverTime": datetime.now(UTC).isoformat(),
        }
