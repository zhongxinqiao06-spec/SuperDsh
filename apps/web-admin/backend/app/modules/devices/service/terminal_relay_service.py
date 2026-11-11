"""远端终端绑定和独立 Relay WebSocket，保留请求关联、背压和撤权语义。"""

import asyncio
import base64
import contextlib
import hmac
import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, cast
from uuid import uuid4

from starlette.websockets import WebSocket, WebSocketDisconnect

from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.devices.dao.operation_dao import OperationDao
from app.modules.devices.entity.do.operation_do import TerminalBindingRow
from app.modules.devices.entity.vo.device_dto import TerminalInput
from app.modules.devices.entity.vo.terminal_result import TerminalResult
from app.modules.devices.service.operation_paths import operation_path
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.devices.service.device_service import DeviceService


@dataclass
class RelayConnection:
    """一个终端只保留当前传输代际，替换连接先拒绝旧请求。"""

    binding: TerminalBindingRow
    account: Account
    socket: WebSocket
    pending: dict[str, asyncio.Future[dict[str, object]]] = field(default_factory=dict)
    writer: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class RelayTicket:
    """短期票据由已授权终端操作签发，不能由 Connector 任意选择绑定。"""

    token: str
    account: Account
    binding: TerminalBindingRow
    expires: float
    ready: asyncio.Future[RelayConnection]
    consumed: bool = False


class TerminalRelayService:
    """Relay 只传终端控制和输出，不另建执行任务队列。"""

    def __init__(self, devices: "DeviceService", database: Database) -> None:
        self.devices, self.database = devices, database
        self.connections: dict[str, RelayConnection] = {}
        self.tickets: dict[str, RelayTicket] = {}
        self.connecting: dict[str, asyncio.Lock] = {}

    async def authorize(self, account: Account, connector: str) -> Account:
        """长期 Relay 读取当前角色与账号代际；入口仍需要有效用户登录。"""
        current = await self.devices.identity.get_account(account.user_id)
        current.require("terminal.use")
        if current.auth_version != account.auth_version:
            raise DomainError(401, "终端授权已更新")
        row = await self.devices.own(current, connector, "terminal.use")
        if row.blocked_at or row.revoked:
            raise DomainError(403, "设备连接已阻断")
        return current

    async def binding(
        self, account: Account, connector: str, identifier: str, session_id: str | None = None
    ) -> TerminalBindingRow:
        """终端所属会话也要一致，不能用另一会话路径绕过根绑定。"""
        await self.authorize(account, connector)
        async with self.database.sessions() as session:
            row = await OperationDao(session).binding(identifier, account.user_id)
        if (
            not row
            or row.connector_id != connector
            or session_id is not None
            and row.session_id != session_id
        ):
            raise DomainError(404, "终端不存在")
        return row

    async def create(
        self, account: Account, connector: str, value: TerminalInput
    ) -> dict[str, object]:
        """生成固定终端身份，成功远端创建后持久化会话与根目录绑定。"""
        root, cwd, _ = await operation_path(
            self.devices, account, connector, value.root, value.cwd, "terminal.use"
        )
        identifier = "trm_" + uuid4().hex
        session_id = value.sessionId or "browse_" + connector
        params: dict[str, object] = {
            **value.model_dump(exclude_none=True, exclude_unset=True, by_alias=True),
            "terminalId": identifier,
            "sessionId": session_id,
            "root": root,
            "cwd": cwd,
            "cols": value.cols,
            "rows": value.rows,
            "outputTransport": "relay",
        }
        result = await self.devices.call(
            account, connector, "terminal.create", params, "terminal.use"
        )
        if not isinstance(result, dict):
            raise DomainError(502, "设备终端响应无效")
        row = TerminalBindingRow(
            terminal_id=identifier,
            owner_id=account.user_id,
            connector_id=connector,
            session_id=session_id,
            root=root,
            cwd=cwd,
            created_at=datetime.now(UTC),
        )
        try:
            async with self.database.sessions() as session, session.begin():
                await OperationDao(session).save(row)
        except BaseException:
            with contextlib.suppress(DomainError):
                await self.devices.call(
                    account,
                    connector,
                    "terminal.close",
                    {"terminalId": identifier, "sessionId": session_id, "root": root, "cwd": cwd},
                    "terminal.use",
                )
            raise
        terminal = result.get("terminal", result)
        if not isinstance(terminal, dict):
            raise DomainError(502, "设备终端信息无效")
        return TerminalResult(
            {
                "terminal": {
                    **terminal,
                    "id": identifier,
                    "terminalId": identifier,
                    "name": terminal.get("name", terminal.get("label", value.name)),
                    "cols": terminal.get("cols", value.cols),
                    "rows": terminal.get("rows", value.rows),
                    "status": terminal.get("status", "running"),
                    "persistence": terminal.get("persistent", value.persistence),
                },
                "serverTime": datetime.now(UTC).isoformat(),
            },
            result,
        )

    async def _connection(self, account: Account, binding: TerminalBindingRow) -> RelayConnection:
        key = binding.connector_id + ":" + binding.terminal_id
        lock = self.connecting.setdefault(key, asyncio.Lock())
        try:
            async with lock:
                existing = self.connections.get(key)
                if existing:
                    await self.authorize(account, binding.connector_id)
                    return existing
                if len(self.connections) >= 200:
                    raise DomainError(429, "终端连接过多")
                ticket = RelayTicket(
                    "relay_" + uuid4().hex + uuid4().hex,
                    account,
                    binding,
                    time.monotonic() + 60,
                    asyncio.get_running_loop().create_future(),
                )
                self.tickets[binding.terminal_id] = ticket
                try:
                    await self.devices.call(
                        account,
                        binding.connector_id,
                        "terminal.relay.connect",
                        {
                            "terminalId": binding.terminal_id,
                            "sessionId": binding.session_id,
                            "token": ticket.token,
                            "mode": "attach",
                        },
                        "terminal.use",
                    )
                    return await asyncio.wait_for(ticket.ready, 10)
                finally:
                    if self.tickets.get(binding.terminal_id) is ticket:
                        self.tickets.pop(binding.terminal_id, None)
        finally:
            if not lock.locked() and not getattr(lock, "_waiters", None):
                self.connecting.pop(key, None)

    async def call(
        self,
        account: Account,
        connector: str,
        identifier: str,
        action: str,
        value: dict[str, object],
    ) -> dict[str, object]:
        """每个请求最多等待十五秒，取消后移除关联，不自动重发输入。"""
        binding = await self.binding(account, connector, identifier)
        method = {"write": "terminal.write", "persistence": "terminal.setPersistent"}.get(
            action, "terminal." + action
        )
        params: dict[str, object] = {
            **value,
            "terminalId": identifier,
            "sessionId": binding.session_id,
            "root": binding.root,
            "cwd": binding.cwd,
        }
        if action == "write":
            encoded = value.get("dataBase64")
            if encoded is None:
                raw = value.get("data")
                if not isinstance(raw, str) or len(raw.encode()) > 65536:
                    raise DomainError(422, "终端输入无效")
                encoded = base64.b64encode(raw.encode()).decode()
            if not isinstance(encoded, str) or len(encoded) > 90000:
                raise DomainError(422, "终端输入无效")
            try:
                if len(base64.b64decode(encoded, validate=True)) > 65536:
                    raise DomainError(422, "终端输入超过限制")
            except ValueError as error:
                raise DomainError(422, "终端输入编码无效") from error
            params["dataBase64"] = encoded
        if action in {"write", "resize", "snapshot", "close"}:
            connection = await self._connection(account, binding)
            if len(connection.pending) >= 64:
                raise DomainError(429, "终端请求繁忙")
            request_id = "relay_" + uuid4().hex
            future: asyncio.Future[dict[str, object]] = asyncio.get_running_loop().create_future()
            connection.pending[request_id] = future
            try:
                async with asyncio.timeout(15):
                    async with connection.writer:
                        await connection.socket.send_json(
                            {
                                **params,
                                "type": "input" if action == "write" else action,
                                "requestId": request_id,
                                "data": params.get("dataBase64", params.get("data")),
                            }
                        )
                    result = await future
            except TimeoutError as error:
                raise DomainError(504, "终端 Relay 响应超时") from error
            finally:
                connection.pending.pop(request_id, None)
        else:
            raw_result = await self.devices.call(account, connector, method, params, "terminal.use")
            if not isinstance(raw_result, dict):
                raise DomainError(502, "终端响应无效")
            result = cast(dict[str, object], raw_result)
        if action == "close":
            async with self.database.sessions() as session, session.begin():
                row = await OperationDao(session).binding(identifier, account.user_id)
                if row:
                    await OperationDao(session).remove_binding(row)
            closed_connection = self.connections.get(connector + ":" + identifier)
            if closed_connection:
                await closed_connection.socket.close(1000, "terminal closed")
        return result

    async def serve(self, identifier: str, token: str, socket: WebSocket) -> None:
        """附加帧只接受平台发出的单次 Relay 票据，绑定身份不能由帧覆盖。"""
        ticket = self.tickets.get(identifier)
        if (
            not ticket
            or ticket.consumed
            or ticket.expires < time.monotonic()
            or not hmac.compare_digest(ticket.token, token)
        ):
            raise DomainError(401, "relay authorization required")
        await self.authorize(ticket.account, ticket.binding.connector_id)
        if ticket.consumed:
            raise DomainError(401, "relay authorization consumed")
        ticket.consumed = True
        connection = RelayConnection(ticket.binding, ticket.account, socket)
        key = ticket.binding.connector_id + ":" + identifier
        await socket.accept()
        self.connections[key] = connection
        try:
            await asyncio.wait_for(
                socket.send_json(
                    {
                        "type": "start",
                        "mode": "attach",
                        "terminalId": identifier,
                        "sessionId": ticket.binding.session_id,
                        "root": ticket.binding.root,
                        "cwd": ticket.binding.cwd,
                        "cols": 80,
                        "rows": 24,
                        "env": {},
                        "persistent": False,
                    }
                ),
                10,
            )
            if not ticket.ready.done():
                ticket.ready.set_result(connection)
            while True:
                await self.authorize(ticket.account, ticket.binding.connector_id)
                try:
                    raw = await asyncio.wait_for(socket.receive_text(), 5)
                except TimeoutError:
                    continue
                if len(raw.encode()) > 2 * 1024 * 1024:
                    raise DomainError(413, "终端 Relay 帧过大")
                frame: object = json.loads(raw)
                if not isinstance(frame, dict):
                    raise DomainError(422, "终端 Relay 帧无效")
                request_id = frame.get("requestId")
                future = connection.pending.get(str(request_id))
                if future and not future.done():
                    if (
                        frame.get("type") == "error"
                        or frame.get("ok") is False
                        or frame.get("error")
                    ):
                        future.set_exception(DomainError(502, "远端终端拒绝操作"))
                    else:
                        result = frame.get("result", frame)
                        future.set_result(
                            cast(dict[str, object], result) if isinstance(result, dict) else {}
                        )
        except (WebSocketDisconnect, RuntimeError, DomainError, ValueError, TimeoutError):
            pass
        finally:
            if self.connections.get(key) is connection:
                self.connections.pop(key, None)
            for future in connection.pending.values():
                if not future.done():
                    future.set_exception(DomainError(409, "终端 Relay 已断开"))
            with contextlib.suppress(WebSocketDisconnect, RuntimeError):
                await socket.close(1008, "relay ended")

    async def close(self) -> None:
        """关闭连接只回收传输，不对远端终端发送重复关闭命令。"""
        self.tickets.clear()
        for connection in list(self.connections.values()):
            with contextlib.suppress(WebSocketDisconnect, RuntimeError):
                await connection.socket.close(1001, "server shutdown")
        self.connections.clear()
