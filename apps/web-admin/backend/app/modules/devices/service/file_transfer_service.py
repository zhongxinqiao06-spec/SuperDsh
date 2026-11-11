"""有界设备文件传输与一次性预览授权，凭据不进入下载地址或日志。"""

import asyncio
import base64
import contextlib
import hashlib
import hmac
import mimetypes
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from app.infrastructure.crypto import digest
from app.infrastructure.errors import DomainError
from app.modules.devices.entity.vo.device_dto import FileRequest
from app.modules.devices.service.operation_paths import operation_path
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.devices.service.device_service import DeviceService


@dataclass
class PreviewAccess:
    """令牌只绑定单一文件；原登录会话失效后预览立即失效。"""

    owner: str
    connector: str
    root: str
    path: str
    credential: str
    expires: float
    exchange: bool
    consumed: bool = False


@dataclass
class FileTransfer:
    """传输分片写入验证目录外的运行缓存，校验成功前不公开内容。"""

    id: str
    connector: str
    owner: str
    credential: str
    token: str
    root: str
    path: str
    metadata: dict[str, object]
    expires: float
    local: bool
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    uploading: bool = False
    downloading: bool = False
    error: str | None = None
    temporary: Path | None = None


class FileTransferService:
    """短期票据与单进程传输有容量上限，重启直接失效，不重放上传或命令。"""

    maximum = 64 * 1024 * 1024

    def __init__(self, devices: "DeviceService") -> None:
        self.devices = devices
        self.accesses: dict[str, PreviewAccess] = {}
        self.transfers: dict[str, FileTransfer] = {}
        self.directory = devices.runtime_root / "device-transfers"

    async def initialize(self) -> None:
        """重启撤销旧短期传输，只清理本服务固定命名的分片文件。"""
        if self.directory.exists():
            for path in self.directory.glob("transfer_*.part"):
                if path.parent == self.directory and len(path.stem) == len("transfer_") + 32:
                    await asyncio.to_thread(path.unlink, missing_ok=True)

    async def authorize(self, credential: str, connector: str, owner: str) -> Account:
        """凭据、账号与设备归属同时有效，管理员权限不放宽文件边界。"""
        account = await self.devices.identity.authenticate(credential)
        account.require("files.read")
        if account.user_id != owner:
            raise DomainError(401, "文件访问身份已变化")
        device = await self.devices.own(account, connector, "files.read")
        if device.blocked_at or device.revoked:
            raise DomainError(403, "设备连接已被阻断")
        return account

    def prune(self) -> None:
        """过期对象不留在内存或磁盘；活跃传输有独立超时，不由清理中途删除。"""
        now = time.monotonic()
        for key, value in list(self.accesses.items()):
            if value.expires <= now or value.consumed:
                self.accesses.pop(key, None)
        for key, transfer in list(self.transfers.items()):
            if transfer.expires <= now and not transfer.uploading and not transfer.downloading:
                if transfer.temporary:
                    transfer.temporary.unlink(missing_ok=True)
                self.transfers.pop(key, None)

    def _issue(self, value: PreviewAccess, seconds: int) -> dict[str, object]:
        self.prune()
        if len(self.accesses) >= 1000:
            raise DomainError(429, "预览会话过多，请稍后重试")
        token = "preview_" + uuid4().hex + uuid4().hex
        self.accesses[digest(token)] = value
        return {
            "expiresAt": datetime.fromtimestamp(
                datetime.now(UTC).timestamp() + seconds, UTC
            ).isoformat(),
            "token": token,
        }

    async def issue(
        self, account: Account, credential: str, connector: str, value: FileRequest
    ) -> dict[str, object]:
        """只有已授权用户可签发一次性、路径固定的预览入口。"""
        root, target, _ = await operation_path(
            self.devices, account, connector, value.root, value.path, "files.read"
        )
        await self.authorize(credential, connector, account.user_id)
        issued = self._issue(
            PreviewAccess(
                account.user_id, connector, root, target, credential, time.monotonic() + 300, True
            ),
            300,
        )
        return {
            "previewToken": issued["token"],
            "expiresAt": issued["expiresAt"],
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def _access(self, token: str, exchange: bool = False) -> tuple[PreviewAccess, Account]:
        value = self.accesses.get(digest(token))
        if (
            not value
            or value.consumed
            or value.exchange != exchange
            or value.expires < time.monotonic()
        ):
            raise DomainError(401, "预览访问已过期")
        account = await self.authorize(value.credential, value.connector, value.owner)
        return value, account

    async def exchange(self, token: str) -> dict[str, object]:
        """兑换前后不发生 await 竞态，单个入口令牌最多成功消费一次。"""
        access, _ = await self._access(token, True)
        if access.consumed:
            raise DomainError(401, "预览令牌已消费")
        access.consumed = True
        issued = self._issue(
            PreviewAccess(
                access.owner,
                access.connector,
                access.root,
                access.path,
                access.credential,
                time.monotonic() + 900,
                False,
            ),
            900,
        )
        return {
            "previewAccessToken": issued["token"],
            "expiresAt": issued["expiresAt"],
            "connectorId": access.connector,
            "root": access.root,
            "path": access.path,
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def preview(self, token: str, text: bool, maximum: int = 1048576) -> object:
        """预览请求无法覆盖令牌绑定的文件路径。"""
        access, account = await self._access(token)
        value = FileRequest(root=access.root, path=access.path, maxBytes=maximum)
        if text:
            return await self.devices.files.execute(account, access.connector, "readText", value)
        return await self.prepare(account, access.credential, access.connector, value)

    async def prepare(
        self, account: Account, credential: str, connector: str, value: FileRequest
    ) -> dict[str, object]:
        """先获取元数据，下载时再核对摘要，不用错误内容冒充成功文件。"""
        self.prune()
        if len(self.transfers) >= 200:
            raise DomainError(429, "文件传输过多，请稍后重试")
        root, target, local = await operation_path(
            self.devices, account, connector, value.root, value.path, "files.read"
        )
        await self.authorize(credential, connector, account.user_id)
        if local:
            metadata = await asyncio.to_thread(self._local_metadata, account.user_id, target)
        else:
            result = await self.devices.call(
                account,
                connector,
                "fs.prepareDownload",
                {"sessionId": "browse_" + connector, "root": root, "path": target},
                "files.read",
            )
            if not isinstance(result, dict):
                raise DomainError(502, "设备文件元数据无效")
            metadata = dict(result)
        size, sha = metadata.get("size"), metadata.get("sha256")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or not 0 <= size <= self.maximum
            or not isinstance(sha, str)
            or len(sha) != 64
            or any(ch not in "0123456789abcdef" for ch in sha)
        ):
            raise DomainError(422, "文件元数据或大小不符合传输限制")
        identifier, token = "transfer_" + uuid4().hex, "download_" + uuid4().hex
        safe_metadata = {
            key: metadata[key]
            for key in ("size", "sha256", "name", "mediaType", "path", "modifiedAt")
            if key in metadata
        }
        transfer = FileTransfer(
            identifier,
            connector,
            account.user_id,
            credential,
            token,
            root,
            target,
            safe_metadata,
            time.monotonic() + 300,
            local,
        )
        self.transfers[identifier] = transfer
        encoded = metadata.get("contentBase64")
        if isinstance(encoded, str):
            try:
                content = base64.b64decode(encoded, validate=True)
                self._validate(transfer, content)
                transfer.temporary = self._temporary(identifier)
                await asyncio.to_thread(transfer.temporary.write_bytes, content)
                transfer.ready.set()
            except (ValueError, OSError, DomainError) as error:
                self.transfers.pop(identifier, None)
                if transfer.temporary:
                    transfer.temporary.unlink(missing_ok=True)
                raise DomainError(502, "设备文件数据无效") from error
        return {
            "ok": True,
            "result": {
                **safe_metadata,
                "transferId": identifier,
                "token": token,
                "downloadUrl": f"/api/connectors/{connector}/fs/transfers/{identifier}?token={token}",
            },
            "error": None,
        }

    def _temporary(self, identifier: str) -> Path:
        self.directory.mkdir(parents=True, exist_ok=True)
        return self.directory / (identifier + ".part")

    def _local_metadata(self, owner: str, target: str) -> dict[str, object]:
        path = self.devices.files.resolve(owner, target)
        if not path.is_file():
            raise DomainError(404, "文件不存在")
        size = path.stat().st_size
        if size > self.maximum:
            raise DomainError(413, "文件超过传输大小上限")
        digestor, count = hashlib.sha256(), 0
        with path.open("rb") as stream:
            while data := stream.read(65536):
                count += len(data)
                if count > self.maximum:
                    raise DomainError(413, "文件超过传输大小上限")
                digestor.update(data)
        return {
            "path": str(path),
            "name": path.name,
            "size": count,
            "sha256": digestor.hexdigest(),
            "mediaType": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        }

    def _find(self, identifier: str, token: str) -> FileTransfer:
        transfer = self.transfers.get(identifier)
        if (
            not transfer
            or transfer.expires < time.monotonic()
            or not hmac.compare_digest(transfer.token, token)
        ):
            raise DomainError(404, "transfer not found")
        return transfer

    @staticmethod
    def _validate(transfer: FileTransfer, content: bytes) -> None:
        if (
            len(content) != transfer.metadata["size"]
            or hashlib.sha256(content).hexdigest() != transfer.metadata["sha256"]
        ):
            raise DomainError(422, "文件传输大小或摘要不一致")

    async def receive(
        self, identifier: str, token: str, connector_credential: str, stream: AsyncIterator[bytes]
    ) -> dict[str, str]:
        """Connector 必须证明设备凭据和传输票据；分片校验完成后才唤醒下载。"""
        device = await self.devices.authenticate(connector_credential)
        transfer = self._find(identifier, token)
        if transfer.connector != device.id or transfer.local:
            raise DomainError(404, "文件传输不存在")
        await self.authorize(transfer.credential, transfer.connector, transfer.owner)
        if transfer.uploading or transfer.ready.is_set():
            raise DomainError(409, "文件传输已经开始")
        transfer.uploading = True
        transfer.temporary = self._temporary(identifier)
        digestor, size = hashlib.sha256(), 0
        try:
            async with asyncio.timeout(60):
                with transfer.temporary.open("wb") as output:
                    async for chunk in stream:
                        size += len(chunk)
                        if size > int(str(transfer.metadata["size"])) or size > self.maximum:
                            raise DomainError(422, "文件传输大小不一致")
                        await self.authorize(
                            transfer.credential, transfer.connector, transfer.owner
                        )
                        await self.devices.authenticate(connector_credential)
                        digestor.update(chunk)
                        await asyncio.to_thread(output.write, chunk)
            if (
                size != transfer.metadata["size"]
                or digestor.hexdigest() != transfer.metadata["sha256"]
            ):
                raise DomainError(422, "文件传输完整性校验失败")
            return {"status": "accepted"}
        except BaseException:
            transfer.error = "文件传输未完成"
            transfer.temporary.unlink(missing_ok=True)
            raise
        finally:
            transfer.uploading = False
            transfer.ready.set()

    async def download(
        self, connector: str, identifier: str, token: str
    ) -> tuple[bytes, dict[str, object]]:
        """单次下载核对当前账号与设备，失败不重新发送有副作用的远端请求。"""
        transfer = self._find(identifier, token)
        if transfer.connector != connector or transfer.downloading:
            raise DomainError(404, "文件传输不存在或正在读取")
        # 在授权 I/O 前占用本次传输，避免两个下载同时通过前置状态检查。
        transfer.downloading = True
        try:
            account = await self.authorize(transfer.credential, connector, transfer.owner)
            async with asyncio.timeout(60):
                if transfer.local:
                    path = self.devices.files.resolve(account.user_id, transfer.path)
                    with path.open("rb") as stream:
                        content = await asyncio.to_thread(stream.read, self.maximum + 1)
                else:
                    if not transfer.ready.is_set() and not transfer.uploading:
                        await self.devices.call(
                            account,
                            connector,
                            "fs.uploadPreparedDownload",
                            {
                                "sessionId": "browse_" + connector,
                                "transferId": identifier,
                                "token": token,
                                "uploadUrl": f"/api/connector/fs/transfers/{identifier}",
                                "root": transfer.root,
                                "path": transfer.path,
                            },
                            "files.read",
                        )
                    await transfer.ready.wait()
                    if transfer.error or not transfer.temporary:
                        raise DomainError(502, transfer.error or "文件传输未返回内容")
                    content = await asyncio.to_thread(transfer.temporary.read_bytes)
                self._validate(transfer, content)
                await self.authorize(transfer.credential, connector, transfer.owner)
                return content, transfer.metadata
        except TimeoutError as error:
            raise DomainError(504, "文件传输超时") from error
        finally:
            self.transfers.pop(identifier, None)
            if transfer.temporary:
                transfer.temporary.unlink(missing_ok=True)

    async def close(self) -> None:
        """退出时撤销票据并删除本服务生成的传输缓存。"""
        self.accesses.clear()
        for transfer in self.transfers.values():
            transfer.error = "服务已退出"
            transfer.ready.set()
            if transfer.temporary:
                with contextlib.suppress(OSError):
                    transfer.temporary.unlink(missing_ok=True)
        self.transfers.clear()
