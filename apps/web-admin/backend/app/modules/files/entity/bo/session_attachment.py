"""会话附件输入与资源内身份，原始客户端fileId不能直接成为全局文件主键。"""

import base64
import binascii
import hashlib
import json
import re

from app.infrastructure.errors import DomainError
from app.infrastructure.input_validation import required_text


def attachment_identity(owner: str, session: str, identifier: str) -> str:
    """不同账号/会话可上传同一摘要命名文件，映射不依赖磁盘路径或客户端身份声明。"""
    encoded = json.dumps([owner, session, identifier], separators=(",", ":")).encode()
    return "file_inline_" + hashlib.sha256(encoded).hexdigest()[:48]


def attachment_identifier(value: object) -> str:
    """保留旧安全身份字符集，避免路径字符进入下载别名。"""
    identifier = required_text(value, "fileId", 64)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", identifier):
        raise DomainError(422, "invalid file identifier")
    return identifier


def inline_content(value: dict[str, object]) -> bytes | None:
    """严格base64与声明摘要/大小全部匹配后才允许任何存储写入。"""
    encoded = value.get("contentBase64")
    if not isinstance(encoded, str):
        return None
    identifier = attachment_identifier(value.get("fileId"))
    if identifier.startswith(("artifact_", "preview_", "office_input_")):
        raise DomainError(422, "generated file IDs cannot be overwritten by an upload")
    if len(encoded) > ((32 * 1024 * 1024 + 2) // 3) * 4:
        raise DomainError(413, "attachment is too large")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise DomainError(422, "attachment contentBase64 is invalid") from error
    if not encoded or base64.b64encode(content).decode() != encoded:
        raise DomainError(422, "attachment contentBase64 is invalid")
    if len(content) > 32 * 1024 * 1024:
        raise DomainError(413, "attachment is too large")
    claimed_size = value.get("size")
    if claimed_size is not None and (
        isinstance(claimed_size, bool) or claimed_size != len(content)
    ):
        raise DomainError(422, "attachment size does not match content")
    if value.get("sha256") is not None and value["sha256"] != hashlib.sha256(content).hexdigest():
        raise DomainError(422, "attachment sha256 does not match content")
    return content
