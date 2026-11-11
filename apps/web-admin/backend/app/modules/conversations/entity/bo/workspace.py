"""设备工作区身份由远端操作系统决定，不能按服务器操作系统或统一大小写推断。"""

import ntpath
import posixpath
import re

from app.infrastructure.errors import DomainError


def workspace_key(value: str, device_os: str | None = None) -> str:
    """保留 Windows 驱动器/UNC 与 POSIX 大小写语义，去掉等价分隔符和点路径。"""
    windows = (
        device_os in {"windows", "win32"}
        or bool(re.match(r"^[A-Za-z]:[\\/]", value))
        or value.startswith("\\\\")
    )
    platform = ntpath if windows else posixpath
    if not platform.isabs(value) or "\x00" in value:
        raise DomainError(422, "workspacePath must be an absolute path")
    normalized = platform.normpath(value)
    if windows:
        drive, tail = ntpath.splitdrive(normalized)
        key = normalized.replace("\\", "/").lower()
        if not tail and drive.startswith("\\\\"):
            return key.rstrip("/") + "/"
        return key if tail == "\\" else key.rstrip("/") or "/"
    # Node 的 posix.normalize 将多个前导分隔符合并；Python 保留双斜杠，需要显式对齐。
    return "/" + normalized.lstrip("/")
