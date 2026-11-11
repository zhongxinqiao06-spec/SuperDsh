"""设备所有权、连接授权与固定 DSH 的设备视图。"""

import hashlib
import hmac
import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from app.infrastructure.crypto import CredentialCipher, digest, encode
from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.infrastructure.input_validation import required_text
from app.modules.devices.dao.device_dao import DeviceRepository
from app.modules.devices.entity.do.models import DeviceRow
from app.modules.devices.entity.vo.device_dto import DeviceInput
from app.modules.devices.service.connector_channel import ConnectorChannel
from app.modules.devices.service.pairing_service import PairingService, make_device
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.identity import IdentityService
from app.modules.runtime.entity.bo.values import Fields
from app.modules.runtime.service.runtime import RuntimeService


class DeviceService:
    """只将设备 RPC 转发给已授权连接，不实现 Agent 调度队列。"""

    def __init__(
        self,
        database: Database,
        runtime_getter: Callable[[], RuntimeService | None],
        runtime_root: Path,
        identity: IdentityService,
        cipher: CredentialCipher,
        signing_secret: str,
    ) -> None:
        self.repository = DeviceRepository(database)
        self.runtime_getter, self.runtime_root, self.identity = (
            runtime_getter,
            runtime_root,
            identity,
        )
        self.secret = signing_secret.encode()
        self.cipher = cipher
        self.channel = ConnectorChannel()
        self.pairing = PairingService(self.repository, cipher)
        self.on_notification: (
            Callable[[DeviceRow, str, dict[str, object]], Awaitable[object]] | None
        ) = None
        from app.modules.devices.service.runtime_device_service import RuntimeDeviceService
        from app.modules.devices.service.terminal_service import TerminalService
        from app.modules.devices.service.workspace_service import WorkspaceService

        self.files = WorkspaceService(self)
        self.terminals = TerminalService(self, self.files)
        self.runtimes = RuntimeDeviceService(self)
        from app.modules.devices.service.device_operations import DeviceOperations

        self.operations = DeviceOperations(self, database)

    @staticmethod
    def native_ids(owner: str) -> tuple[str, str]:
        """沿用固定 DSH 所有者映射，与运行监督器协议一致。"""
        suffix = digest(owner)[:24]
        return "conn_server_" + suffix, "proj_server_" + suffix

    def workspace(self, owner: str) -> Path:
        """返回该用户唯一受管工作区；具体文件访问再做真实路径校验。"""
        return self.runtime_root / digest(owner) / "workspace"

    def native(self, account: Account) -> DeviceRow:
        identifier, _ = self.native_ids(account.user_id)
        now = datetime.now(UTC)
        return DeviceRow(
            id=identifier,
            owner_id=account.user_id,
            name="服务器 Agent",
            connector_kind="server-agent",
            executor_kind="server-agent",
            device_os=None,
            token_hash="",
            token_prefix="",
            revoked=False,
            preferences={},
            metadata_json={},
            created_at=now,
            updated_at=now,
        )

    async def ensure_native(self, owner: str) -> None:
        """仅显式准备服务端 Agent 时登记身份，重试和列表查询不能刷新创建时间。"""
        account = await self.identity.get_account(owner)
        account.require("sessions.run")
        identifier, _ = self.native_ids(owner)
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            existing = await dao.device(identifier)
            if existing:
                if existing.owner_id != owner or existing.executor_kind != "server-agent":
                    raise DomainError(409, "managed connector identity conflict")
                return
            await dao.save(self.native(account))

    def view(self, row: DeviceRow) -> dict[str, object]:
        """设备响应不包含长效凭据与内部连接对象。"""
        runtime = self.runtime_getter()
        online = (
            bool(runtime and runtime.runner.status(row.owner_id).get("status") == "running")
            if row.executor_kind == "server-agent"
            else row.id in self.channel.connections
        )
        return {
            "id": row.id,
            "userId": row.owner_id,
            "name": row.name,
            "connectorKind": row.connector_kind,
            "executorKind": row.executor_kind,
            "deviceOs": row.device_os,
            "status": "online" if online and not row.blocked_at else "offline",
            "lastSeenAt": row.last_seen_at.isoformat() if row.last_seen_at else None,
            "createdAt": row.created_at.isoformat(),
            "updatedAt": row.updated_at.isoformat(),
            "blockedAt": row.blocked_at.isoformat() if row.blocked_at else None,
            "blockedReason": row.blocked_reason,
            "version": row.metadata_json.get("version"),
        }

    async def own(
        self, account: Account, identifier: str, permission: str = "devices.read"
    ) -> DeviceRow:
        """管理角色也不能通过普通资源接口读取他人设备。"""
        account.require(permission)
        async with self.repository.transaction() as dao:
            row = await dao.device(identifier)
        if not row or row.owner_id != account.user_id or row.revoked:
            raise DomainError(404, "connector not found")
        return row

    async def connection_online(self, owner: str, identifier: str) -> bool:
        """供已授权领域投影读取连接事实；归属不符、撤销或封禁均不能显示在线。"""
        async with self.repository.transaction() as dao:
            row = await dao.device(identifier)
        if not row or row.owner_id != owner or row.revoked or row.blocked_at:
            return False
        return self.view(row)["status"] == "online"

    async def conversation_sources(
        self, account: Account, permission: str = "sessions.read"
    ) -> dict[str, bool]:
        """会话读取只取得本人未撤销设备及在线事实，不额外要求设备管理权限。"""
        account.require(permission)
        async with self.repository.transaction() as dao:
            rows = await dao.devices(account.user_id)
        return {row.id: self.view(row)["status"] == "online" for row in rows}

    async def listing(
        self,
        account: Account,
        inventory: bool = False,
        page: int = 1,
        page_size: int = 200,
        search: str = "",
    ) -> dict[str, object]:
        """运维列表仅展示设备元数据，分页搜索不会授予设备内容访问权。"""
        account.require("devices.inventory.read" if inventory else "devices.read")
        async with self.repository.transaction() as dao:
            rows = await dao.devices(None if inventory else account.user_id)
        items = [self.view(row) for row in rows]
        server_time = datetime.now(UTC).isoformat()
        if not inventory:
            return {"connectors": items, "items": items, "serverTime": server_time}
        owners: dict[str, Account] = {}
        for item in items:
            owner_id = str(item["userId"])
            if owner_id not in owners:
                owners[owner_id] = await self.identity.get_account(owner_id)
            item["username"] = owners[owner_id].username
        term = search.strip().casefold()
        filtered = [
            item
            for item in items
            if not term
            or any(
                term in str(item[key]).casefold() for key in ("id", "name", "userId", "username")
            )
        ]
        page, page_size = max(1, page), min(200, max(1, page_size))
        selected = filtered[(page - 1) * page_size : page * page_size]
        return {
            "devices": selected,
            "connectors": selected,
            "items": selected,
            "total": len(filtered),
            "page": page,
            "pageSize": page_size,
            "serverTime": server_time,
        }

    async def create(self, account: Account, value: DeviceInput) -> dict[str, object]:
        """安装身份重注册轮换凭据而不重复设备，已删除安装不能被旧客户端复活。"""
        account.require("devices.manage")
        if value.connectorKind not in {"cli", "desktop"}:
            raise DomainError(422, "invalid connectorKind")
        row, token = make_device(account.user_id, value.name, value.connectorKind, "desktop", None)
        if value.installationId:
            row.id = "conn_" + digest(f"{account.user_id}:{value.installationId}")[:24]
        async with self.repository.transaction() as dao:
            await dao.lock("registration:" + row.id)
            previous = await dao.device(row.id)
            if previous:
                if previous.revoked or previous.owner_id != account.user_id:
                    raise DomainError(409, "installation was deleted; use a new installationId")
                previous.token_hash, previous.token_prefix = row.token_hash, row.token_prefix
                previous.updated_at = row.updated_at
                row = previous
            await dao.save(row)
        await self.channel.disconnect(row.id)
        return {
            "connector": self.view(row),
            "connectorToken": token,
            "tokenPrefix": row.token_prefix,
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def update(self, account: Account, identifier: str, name: str) -> dict[str, object]:
        row = await self.own(account, identifier, "devices.manage")
        if row.executor_kind == "server-agent":
            raise DomainError(409, "server Agent lifecycle is managed by the platform")
        if not name.strip() or len(name) > 255:
            raise DomainError(422, "invalid device name")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row.name, row.updated_at = name.strip(), datetime.now(UTC)
            await dao.save(row)
        return {"connector": self.view(row)}

    async def revoke(self, account: Account, identifier: str) -> dict[str, object]:
        row = await self.own(account, identifier, "devices.manage")
        if row.executor_kind == "server-agent":
            raise DomainError(409, "server Agent lifecycle is managed by the platform")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row.revoked, row.updated_at = True, datetime.now(UTC)
            await dao.save(row)
        await self.channel.disconnect(identifier)
        return {"status": "revoked"}

    async def rotate(self, account: Account, identifier: str) -> dict[str, object]:
        """凭据重置与设备删除分离，轮换立即使旧接缝及模型授权失效。"""
        await self.own(account, identifier, "devices.manage")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.device(identifier)
            if not row or row.revoked or row.owner_id != account.user_id:
                raise DomainError(404, "connector not found")
            if row.executor_kind == "server-agent":
                raise DomainError(409, "server Agent credentials are managed by the platform")
            token = "agt_" + encode(secrets.token_bytes(18))
            row.token_hash, row.token_prefix = digest(token), token[:12]
            row.updated_at = datetime.now(UTC)
            await dao.save(row)
        await self.channel.disconnect(identifier)
        return {
            "connector": self.view(row),
            "connectorToken": token,
            "tokenPrefix": row.token_prefix,
        }

    async def block(
        self, account: Account, identifier: str, blocked: bool, reason: str = ""
    ) -> dict[str, object]:
        account.require("devices.connection.manage")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.device(identifier)
            if not row or row.revoked:
                raise DomainError(404, "connector not found")
            row.blocked_at, row.blocked_reason = (
                (datetime.now(UTC), reason[:500] or None) if blocked else (None, None)
            )
            await dao.save(row)
        if blocked:
            await self.channel.disconnect(identifier)
        return {"connector": self.view(row)}

    async def credentials(self, header: str) -> DeviceRow:
        """长效令牌只在换取短令牌时使用，撤销、封禁和账号禁用立即生效。"""
        if not header.startswith("Connector ") or ":" not in header:
            raise DomainError(401, "expected Connector authorization")
        identifier, token = header[10:].split(":", 1)
        row = await self._active(identifier)
        if not hmac.compare_digest(row.token_hash, digest(token)):
            raise DomainError(401, "invalid connector credentials")
        return row

    async def _active(self, identifier: str) -> DeviceRow:
        async with self.repository.transaction() as dao:
            row = await dao.device(identifier)
        if not row or row.revoked or row.blocked_at:
            raise DomainError(401, "connector unavailable")
        account = await self.identity.get_account(row.owner_id)
        account.require("devices.manage")
        return row

    def _signature(self, row: DeviceRow, expires: str) -> str:
        return encode(
            hmac.new(
                self.secret, f"{row.id}:{expires}:{row.token_hash}".encode(), hashlib.sha256
            ).digest()
        )

    async def authenticate(self, token: str) -> DeviceRow:
        """短期令牌绑定最新凭据摘要，不能因已有 WebSocket 绕过撤销。"""
        parts = token.split(".")
        # 未认证字符串先限制 ASCII 和长度，避免 Unicode 数字或超长整数触发 500。
        if (
            len(parts) != 3
            or len(parts[0]) > 100
            or not token.isascii()
            or not 1 <= len(parts[1]) <= 12
            or not parts[1].isdigit()
            or len(parts[2]) != 43
            or int(parts[1]) <= int(time.time())
        ):
            raise DomainError(401, "invalid connector access token")
        row = await self._active(parts[0])
        if not hmac.compare_digest(parts[2], self._signature(row, parts[1])):
            raise DomainError(401, "invalid connector access")
        return row

    async def auth(self, header: str) -> dict[str, object]:
        row = await self.credentials(header)
        expires = str(int(time.time()) + 900)
        return {
            "accessToken": f"{row.id}.{expires}.{self._signature(row, expires)}",
            "expiresIn": 900,
            "tokenType": "Bearer",
            "connectorId": row.id,
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def model_principal(self, token: str) -> dict[str, object]:
        """模型代理只接收已认证主体与凭据指纹，跨域不传递设备实体。"""
        row = await self.authenticate(token)
        return {"id": row.id, "userId": row.owner_id, "tokenHash": row.token_hash}

    async def authorize_models(
        self, account: Account, connector_id: str, credential_fingerprint: str | None = None
    ) -> None:
        """每次模型请求重新检查设备所有权、封禁及凭据代际。"""
        row = await self.own(account, connector_id, "models.use")
        if row.blocked_at or row.revoked:
            raise DomainError(403, "connector unavailable")
        if (
            row.executor_kind != "server-agent"
            and credential_fingerprint is not None
            and not hmac.compare_digest(row.token_hash, credential_fingerprint)
        ):
            raise DomainError(401, "connector credentials changed")

    async def ingest(self, credential: str, value: dict[str, object]) -> dict[str, object]:
        """批量通知逐条确认，单条非法输入不能丢弃同批其他有效事件。"""
        row = await self.authenticate(credential)
        notifications = value.get("notifications")
        if not isinstance(notifications, list):
            notifications = []
        if len(notifications) > 10000:
            raise DomainError(413, "too many notifications")
        accepted = 0
        rejected: list[dict[str, object]] = []
        for index, raw in enumerate(notifications):
            item = raw if isinstance(raw, dict) else {}
            try:
                # 每条通知重新确认凭据，长批次也不能越过并发封禁或撤销。
                row = await self.authenticate(credential)
                method = required_text(item.get("method"), "method")
                params = item.get("params")
                await self.notify(row, method, params if isinstance(params, dict) else {})
                accepted += 1
            except (DomainError, ValueError) as error:
                failure: dict[str, object] = {
                    "index": index,
                    "code": "notification_failed",
                    "message": error.detail if isinstance(error, DomainError) else str(error),
                    "errorType": "NotificationError",
                }
                if "method" in item:
                    failure["method"] = item["method"]
                rejected.append(failure)
            except Exception:
                # 保留可定位日志；批次响应不泄露 SQL、内部路径或通知内容。
                logging.getLogger(__name__).exception(
                    "connector_notification_failed",
                    extra={"connector_id": row.id, "notification_index": index},
                )
                failure = {
                    "index": index,
                    "code": "notification_failed",
                    "message": "invalid notification",
                    "errorType": "NotificationError",
                }
                if "method" in item:
                    failure["method"] = item["method"]
                rejected.append(failure)
        return {
            "accepted": accepted,
            "rejected": rejected,
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def notify(self, row: DeviceRow, method: str, params: dict[str, object]) -> object:
        """先持久化业务通知再确认；协议服务负责未来通知和废弃通知的不同语义。"""
        if method == "connector.preferencesUpdated":
            async with self.repository.transaction() as dao:
                current = await dao.device(row.id)
                if current:
                    current.preferences = dict(params)
                    await dao.save(current)
            return {"accepted": True}
        if method == "runtime.statusChanged":
            async with self.repository.transaction() as dao:
                current_runtime = await dao.runtime(row.id, str(params.get("runtimeId", "")))
                if current_runtime:
                    current_runtime.status = str(params.get("status", "unknown"))[:30]
                    current_runtime.metadata_json = {
                        **current_runtime.metadata_json,
                        "error": params.get("error"),
                    }
                    current_runtime.updated_at = datetime.now(UTC)
                    await dao.save(current_runtime)
            return {"accepted": True}
        if method in {
            "protocol.capabilitiesUpdated",
            "runtime.capability.updated",
            "runtime.catalog.updated",
            "catalog.model.update",
            "catalog.permission.update",
        } and not params.get("sessionId"):
            async with self.repository.transaction() as dao:
                current = await dao.device(row.id)
                if current:
                    current.metadata_json = {**current.metadata_json, method: dict(params)}
                    await dao.save(current)
            return {"accepted": True}
        if method.startswith(("terminal.", "shell.task.")):
            # 终端输出恢复由终端 snapshot 协议提供，通知不混入会话事实。
            return {"accepted": True}
        if method in {"connector.heartbeat", "heartbeat", "connector.hello", "connector.register"}:
            async with self.repository.transaction() as dao:
                current = await dao.device(row.id)
                if current:
                    current.last_seen_at = datetime.now(UTC)
                    if method in {"connector.hello", "connector.register"}:
                        current.metadata_json = {
                            key: params[key]
                            for key in ("version", "capabilities", "runtimeTypes")
                            if key in params
                        }
                    await dao.save(current)
            return {"accepted": True}
        if self.on_notification:
            return await self.on_notification(row, method, params)
        raise DomainError(422, "unsupported connector notification")

    async def call(
        self,
        account: Account,
        identifier: str,
        method: str,
        params: dict[str, object],
        permission: str = "sessions.run",
        timeout_seconds: float = 60,
    ) -> object:
        """受管 DSH 走唯一运行端口，远程设备走同一 RPC 协议。"""
        row = await self.own(account, identifier, permission)
        if row.blocked_at:
            raise DomainError(403, "connector blocked")
        if row.executor_kind != "server-agent":
            return await self.channel.call(identifier, method, params, timeout_seconds)
        runtime = self.runtime_getter()
        if not runtime:
            raise DomainError(503, "runtime unavailable")
        return await runtime.call(account.user_id, method, cast(Fields, params))

    async def stats(self, account: Account) -> dict[str, object]:
        """总览只读设备表，不准备 DSH、不创建全量订阅。"""
        account.require("devices.inventory.read")
        async with self.repository.transaction() as dao:
            rows = await dao.devices()
        users: dict[str, int] = {}
        for row in rows:
            users[row.owner_id] = users.get(row.owner_id, 0) + 1
        return {
            "devices": len(rows),
            "onlineDevices": sum(row.id in self.channel.connections for row in rows),
            "devicesByUser": users,
        }

    async def facts(
        self, account: Account, from_date: str | None, to_date: str | None, timezone: str
    ) -> dict[str, object]:
        """统计公开事实只含设备元数据，不触发连接或读取设备内容。"""
        account.require("settings.manage")
        async with self.repository.transaction() as dao:
            rows = [row for row in await dao.devices() if not row.revoked]
            installed: set[tuple[str, str]] = set()
            for row in rows:
                installed.update(
                    (row.id, runtime.runtime_type)
                    for runtime in await dao.runtimes(row.id)
                    if runtime.configuration is not None
                )
        return {
            "devices": [
                {
                    "userId": row.owner_id,
                    "id": row.id,
                    "type": row.connector_kind,
                    "deviceOs": row.device_os or "unknown",
                    "createdAt": row.created_at.isoformat(),
                }
                for row in rows
            ],
            "runtimes": [
                {"connectorId": connector, "type": kind} for connector, kind in sorted(installed)
            ],
        }

    async def close(self) -> None:
        """关闭传输并撤销所有未完成 RPC。"""
        await self.terminals.close()
        await self.channel.close()
