"""有界multipart协议解码；上传临时内容保持内存，不落入源码或系统临时目录。"""

from dataclasses import dataclass

from python_multipart.multipart import File, FormParser, parse_options_header

from app.infrastructure.errors import DomainError


@dataclass(frozen=True)
class UploadPart:
    """已解码上传字段，不携带客户端可指定的宿主路径。"""

    name: str
    content: bytes
    media_type: str


def attachment_parts(content_type: str, content: bytes) -> list[UploadPart]:
    """保留最多10个附件、单文件32MiB和请求64MiB上限，截断包明确失败。"""
    media, options = parse_options_header(content_type)
    if media != b"multipart/form-data":
        raise DomainError(415, "multipart/form-data required")
    boundary = options.get(b"boundary")
    if not boundary or len(boundary) > 200:
        raise DomainError(422, "invalid multipart boundary")
    if len(content) > 64 * 1024 * 1024:
        raise DomainError(413, "file is too large")
    parts: list[UploadPart] = []
    ended = False

    def file_received(file: File) -> None:
        try:
            if len(parts) >= 10:
                raise DomainError(413, "too many attachments")
            file.file_object.seek(0)
            data = file.file_object.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                raise DomainError(413, "attachment is too large")
            parts.append(
                UploadPart(
                    (file.file_name or b"attachment").decode("utf-8"),
                    data,
                    file.content_type or "application/octet-stream",
                )
            )
        finally:
            file.close()

    def end_received() -> None:
        nonlocal ended
        ended = True

    parser = FormParser(
        "multipart/form-data",
        None,
        file_received,
        on_end=end_received,
        boundary=boundary,
        config={
            "MAX_MEMORY_FILE_SIZE": 64 * 1024 * 1024,
            "MAX_BODY_SIZE": 64 * 1024 * 1024,
            "MAX_FIELDS": 20,
            "MAX_FIELD_SIZE": 4096,
        },
    )
    try:
        parser.write(content)
        parser.finalize()
        if not ended:
            raise DomainError(422, "incomplete multipart body")
    except (ValueError, UnicodeError) as error:
        raise DomainError(422, "invalid multipart body") from error
    finally:
        parser.close()
    return parts
