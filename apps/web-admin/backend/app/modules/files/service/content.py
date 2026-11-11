"""文件内容类型和范围校验，下载不信任客户端声明的 MIME。"""

import io
import re
import zipfile

from app.infrastructure.errors import DomainError


def media_type(data: bytes, name: str, claimed: str) -> str:
    """校验常见二进制签名与 Office 包结构，拒绝伪装为可内联媒体的内容。"""
    actual = ""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        actual = "image/png"
    elif data.startswith(b"\xff\xd8\xff"):
        actual = "image/jpeg"
    elif data.startswith((b"GIF87a", b"GIF89a")):
        actual = "image/gif"
    elif data.startswith(b"%PDF-"):
        actual = "application/pdf"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        actual = "image/webp"
    elif data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        actual = "audio/wav"
    elif data[:4] == b"OggS":
        actual = "audio/ogg"
    elif data.startswith(b"ID3"):
        actual = "audio/mpeg"
    elif data[4:8] == b"ftyp":
        actual = "audio/mp4" if name.lower().endswith(".m4a") else "video/mp4"
    elif data.startswith(b"PK\x03\x04"):
        suffix = name.rsplit(".", 1)[-1].lower()
        package = {
            "docx": ("word/document.xml", "wordprocessingml.document"),
            "xlsx": ("xl/workbook.xml", "spreadsheetml.sheet"),
            "pptx": ("ppt/presentation.xml", "presentationml.presentation"),
        }.get(suffix)
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if any(
                    info.file_size > 128 * 1024 * 1024
                    or ".." in info.filename.split("/")
                    or info.filename.startswith("/")
                    for info in archive.infolist()
                ):
                    raise DomainError(422, "归档结构无效")
                if package and (
                    package[0] not in archive.namelist()
                    or "[Content_Types].xml" not in archive.namelist()
                ):
                    raise DomainError(422, "Office 文件结构无效")
        except zipfile.BadZipFile as error:
            raise DomainError(422, "归档已损坏") from error
        actual = (
            "application/vnd.openxmlformats-officedocument." + package[1]
            if package
            else "application/zip"
        )
    if actual:
        if claimed and claimed != "application/octet-stream" and claimed.split(";")[0] != actual:
            raise DomainError(422, "文件类型与实际内容不一致")
        return actual
    if claimed.startswith(("image/", "audio/", "video/", "application/pdf")):
        raise DomainError(422, "无法识别文件的实际格式")
    return (
        "text/plain"
        if re.search(r"\.(txt|md|csv|json)$", name, re.I) and b"\0" not in data
        else "application/octet-stream"
    )


def byte_range(value: str | None, size: int) -> tuple[int, int] | None:
    """只接受单个合法 Range；后缀范围也必须落在对象大小内。"""
    if not value:
        return None
    # 足够覆盖无符号64位对象大小，超长或非ASCII十进制直接作为无效范围处理。
    match = re.fullmatch(r"bytes=([0-9]{0,20})-([0-9]{0,20})", value)
    if not match or size <= 0 or not any(match.groups()):
        raise DomainError(416, "invalid range")
    first, last = match.groups()
    if not first:
        count = int(last)
        if count < 1:
            raise DomainError(416, "invalid range")
        return max(0, size - count), size - 1
    start, end = int(first), min(int(last), size - 1) if last else size - 1
    if start >= size or end < start:
        raise DomainError(416, "invalid range")
    return start, end
