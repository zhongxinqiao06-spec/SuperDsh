"""内联附件与已上传附件共用文件库发布、幂等身份和会话引用。"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.infrastructure.input_validation import required_text
from app.modules.files.entity.bo.session_attachment import (
    attachment_identifier,
    attachment_identity,
    inline_content,
)
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.files.service.file_service import FileService


class SessionAttachmentService:
    """调用方先验证会话归属；本用例只在相同所有者和会话作用域内发布文件。"""

    def __init__(self, files: FileService) -> None:
        self.files = files

    async def stage(
        self, account: Account, session_id: str, values: list[dict[str, object]]
    ) -> list[tuple[str, bytes, dict[str, object]]]:
        """返回保留客户端别名的已提交附件；重试不会生成第二个文件或覆盖不同内容。"""
        account.require("sessions.run")
        if len(values) > 10:
            raise DomainError(413, "too many attachments")
        decoded = [
            (attachment_identifier(item.get("fileId")), inline_content(item), item)
            for item in values
        ]
        if len({identifier for identifier, _, _ in decoded}) != len(decoded):
            raise DomainError(422, "invalid or duplicate attachment")
        output = []
        for identifier, content, item in decoded:
            if content is None:
                # 新网页可先上传文件库；原客户端已绑定的摘要别名由资源作用域解析。
                try:
                    content, metadata = await self.files.read_bound(
                        account, identifier, "session", session_id, "sessions.run"
                    )
                except DomainError as error:
                    if error.status != 404:
                        raise
                    content, metadata = await self.files.read(account, identifier)
                for key in ("size", "sha256", "mediaType"):
                    if key in item and item[key] != metadata[key]:
                        raise DomainError(422, "attachment does not match uploaded content")
            else:
                name = required_text(item.get("name"), "attachment name", 512)
                claimed = item.get("mediaType")
                media = claimed if isinstance(claimed, str) else "application/octet-stream"
                try:
                    metadata = await self.files._ingest(
                        account,
                        name,
                        content,
                        media,
                        None,
                        None,
                        "sessions.run",
                        attachment_identity(account.user_id, session_id, identifier),
                    )
                except DomainError as error:
                    if error.status == 409:
                        raise DomainError(409, "历史文件标识不可覆盖，请保存新版本") from error
                    raise
            await self.files._bind(
                account, str(metadata["id"]), "session", session_id, "sessions.run"
            )
            output.append((identifier, content, metadata))
        return output
