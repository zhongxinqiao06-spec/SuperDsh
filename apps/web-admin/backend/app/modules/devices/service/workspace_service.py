"""受管工作区文件操作，授权、真实路径与内容条件必须同时满足。"""

import asyncio
import base64
import hashlib
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.devices.entity.vo.device_dto import FileRequest
from app.modules.devices.service.device_service import DeviceService
from app.modules.devices.service.operation_paths import operation_path
from app.modules.identity.entity.bo.models import Account


class WorkspaceService:
    """文件管理独立于 Agent 执行，不能用远端路径访问服务器任意目录。"""

    def __init__(self, devices: DeviceService) -> None:
        self.devices = devices
        self._locks: dict[str, asyncio.Lock] = {}

    def resolve(self, owner: str, name: str, create_parent: bool = False) -> Path:
        """既检查词法边界又检查符号链接最终目标，拒绝根本身被替换。"""
        root = self.devices.workspace(owner)
        if any(part.is_symlink() for part in (root, root.parent, root.parent.parent)):
            raise DomainError(403, "workspace root is not trusted")
        root = root.resolve()
        path = Path(name)
        if "\x00" in name or any(part == ".." for part in path.parts):
            raise DomainError(403, "path outside workspace")
        target = (path if path.is_absolute() else root / path).resolve()
        if target != root and root not in target.parents:
            raise DomainError(403, "path outside workspace")
        if create_parent:
            target.parent.mkdir(parents=True, exist_ok=True)
        return target

    async def execute(
        self, account: Account, connector: str, action: str, value: FileRequest
    ) -> object:
        """远端请求保留原始 RPC 字段；本地写入在锁内执行摘要条件校验。"""
        permission = "files.write" if action == "write" else "files.read"
        root, target, local = await operation_path(
            self.devices, account, connector, value.root, value.path, permission
        )
        value = value.model_copy(update={"root": root, "path": target})
        methods = {
            "list": "fs.readDir",
            "readText": "fs.readText",
            "write": "fs.writeFile",
            "read": "fs.read",
        }
        if action not in methods:
            raise DomainError(404, "file action unavailable")
        if not local:
            result = await self.devices.call(
                account,
                connector,
                methods[action],
                {**value.model_dump(exclude_none=True), "sessionId": "browse_" + connector},
                permission,
            )
            if action == "readText":
                if not isinstance(result, dict):
                    raise DomainError(502, "设备文本响应无效")
                return {**result, "serverTime": datetime.now(UTC).isoformat()}
            return {"ok": True, "result": result, "error": None}
        key = account.user_id + ":" + str(self.resolve(account.user_id, value.path))
        lock = self._locks.setdefault(key, asyncio.Lock())
        try:
            async with lock:
                local_result = await asyncio.to_thread(self._local, account.user_id, action, value)
                return (
                    {**local_result, "serverTime": datetime.now(UTC).isoformat()}
                    if action == "readText"
                    else {"ok": True, "result": local_result, "error": None}
                )
        finally:
            if not lock.locked() and not getattr(lock, "_waiters", None):
                self._locks.pop(key, None)

    def _local(self, owner: str, action: str, value: FileRequest) -> dict[str, object]:
        target = self.resolve(owner, value.path, action == "write")
        try:
            if action == "list":
                if not target.exists() and target == self.devices.workspace(owner).resolve():
                    return {"path": str(target), "entries": []}
                if not target.is_dir():
                    raise DomainError(404, "directory not found")
                entries: list[dict[str, object]] = []
                for child in sorted(
                    target.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold())
                ):
                    if len(entries) >= 5000:
                        raise DomainError(413, "directory contains too many entries")
                    resolved = self.resolve(owner, str(child))
                    stat = resolved.stat()
                    entries.append(
                        {
                            "name": child.name,
                            "path": str(child),
                            "type": "directory" if resolved.is_dir() else "file",
                            "isDirectory": resolved.is_dir(),
                            "size": stat.st_size,
                            "modifiedAt": int(stat.st_mtime * 1000),
                        }
                    )
                return {"path": str(target), "entries": entries}
            if action == "write":
                if value.content is None:
                    raise DomainError(422, "content required")
                data = value.content.encode("utf-8")
                if len(data) > 4 * 1024 * 1024:
                    raise DomainError(413, "text too large")
                current = (
                    hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
                )
                if value.ifMatch is not None and value.ifMatch.strip('"') != current:
                    raise DomainError(412, "file changed since it was read")
                temporary = target.parent / (".superdsh-write-" + uuid4().hex)
                try:
                    temporary.write_bytes(data)
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
                return {
                    "path": str(target),
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "etag": hashlib.sha256(data).hexdigest(),
                }
            if not target.is_file():
                raise DomainError(404, "file not found")
            maximum = min(
                value.maxBytes, 4 * 1024 * 1024 if action == "readText" else 64 * 1024 * 1024
            )
            if target.stat().st_size > maximum:
                raise DomainError(413, "file too large")
            with target.open("rb") as stream:
                data = stream.read(maximum + 1)
            if len(data) > maximum:
                raise DomainError(413, "file too large")
            content = (
                data.decode("utf-8") if action == "readText" else base64.b64encode(data).decode()
            )
            if action == "readText" and "\x00" in content:
                raise DomainError(415, "file is not editable text")
            result: dict[str, object] = {
                "path": str(target),
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "etag": hashlib.sha256(data).hexdigest(),
            }
            result["content" if action == "readText" else "contentBase64"] = content
            return result
        except UnicodeDecodeError as error:
            raise DomainError(415, "file is not UTF-8 text") from error
        except OSError as error:
            raise DomainError(409, "workspace file operation failed") from error
