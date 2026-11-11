"""远端词法路径与服务器真实路径分开检查，避免跨操作系统路径逃逸。"""

import ntpath
import posixpath
from pathlib import Path
from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.devices.service.device_service import DeviceService


def remote_path(root: str, value: str) -> str:
    """保留 Windows/UNC 与 POSIX 设备语义，绝不使用服务器 OS 推断远端路径。"""
    platform = ntpath if ntpath.splitdrive(root)[0] or root.startswith("\\\\") else posixpath
    if not root or not platform.isabs(root) or "\x00" in root + value:
        raise DomainError(422, "请选择设备的绝对工作区路径")
    base = platform.normpath(root)
    target = platform.normpath(platform.join(base, value))
    try:
        relative = platform.relpath(target, base)
    except ValueError as error:
        raise DomainError(403, "路径超出所选工作区") from error
    if relative == ".." or relative.startswith(".." + platform.sep) or platform.isabs(relative):
        raise DomainError(403, "路径超出所选工作区")
    return target


async def operation_path(
    devices: "DeviceService",
    account: Account,
    connector: str,
    root: str | None,
    value: str,
    permission: str,
) -> tuple[str, str, bool]:
    """每次操作重新检查设备封禁，服务器只允许本人受管工作区内部路径。"""
    device = await devices.own(account, connector, permission)
    if device.blocked_at or device.revoked:
        raise DomainError(403, "设备连接已被阻断")
    if device.executor_kind != "server-agent":
        base = root or ""
        return base, remote_path(base, value), False
    base_path = devices.files.resolve(account.user_id, root or ".")
    target = devices.files.resolve(
        account.user_id, str(Path(value) if Path(value).is_absolute() else base_path / value)
    )
    if not target.is_relative_to(base_path):
        raise DomainError(403, "路径超出所选工作区")
    return str(base_path), str(target), True
