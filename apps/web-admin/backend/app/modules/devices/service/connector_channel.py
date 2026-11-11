"""远程 Connector 的受限 JSON-RPC 通道，保持旧客户端帧格式。"""

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from uuid import uuid4

from starlette.websockets import WebSocket, WebSocketDisconnect

from app.infrastructure.errors import DomainError


@dataclass
class Connection:
    """只保存当前传输代际，断开时撤销未完成请求。"""

    socket: WebSocket
    pending: dict[str, asyncio.Future[object]] = field(default_factory=dict)
    writer: asyncio.Lock = field(default_factory=asyncio.Lock)


class ConnectorChannel:
    """设备连接不承载 Agent 队列；只关联客户端 RPC 和通知。"""

    def __init__(self) -> None:
        self.connections: dict[str, Connection] = {}

    async def call(
        self, connector: str, method: str, params: dict[str, object], timeout_seconds: float = 60
    ) -> object:
        connection = self.connections.get(connector)
        if not connection:
            raise DomainError(409, "connector is offline")
        if len(connection.pending) >= 64:
            raise DomainError(429, "connector requests are busy")
        identifier = "rpc_" + uuid4().hex
        future = asyncio.get_running_loop().create_future()
        connection.pending[identifier] = future
        try:
            # 总期限覆盖写锁、网络背压和响应，不能在发送成功后才开始计时。
            async with asyncio.timeout(max(0.001, min(timeout_seconds, 305))):
                async with connection.writer:
                    await connection.socket.send_json(
                        {"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}
                    )
                return await future
        except TimeoutError as error:
            raise DomainError(504, "connector request timed out") from error
        except (RuntimeError, WebSocketDisconnect) as error:
            raise DomainError(409, "connector disconnected") from error
        finally:
            connection.pending.pop(identifier, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                # 断连可能发生在发送阶段，消费尚未来得及await的失败以免泄漏任务异常。
                future.exception()

    async def disconnect(self, identifier: str) -> None:
        connection = self.connections.pop(identifier, None)
        if connection:
            for future in connection.pending.values():
                if not future.done():
                    future.set_exception(DomainError(409, "connector disconnected"))
            with contextlib.suppress(RuntimeError, WebSocketDisconnect, TimeoutError):
                async with asyncio.timeout(5):
                    await connection.socket.close(1008, "connection closed")

    async def _send(self, connection: Connection, payload: dict[str, object]) -> None:
        """通知确认和心跳共享有界写通道，慢客户端不能卡住授权复验。"""
        async with asyncio.timeout(10):
            async with connection.writer:
                await connection.socket.send_json(payload)

    async def serve(
        self,
        identifier: str,
        socket: WebSocket,
        notify: Callable[[str, dict[str, object]], Awaitable[object]],
        authorize: Callable[[], Awaitable[object]],
    ) -> None:
        """替换旧连接先撤销请求，接收时重新授权并限制消息大小。"""
        await self.disconnect(identifier)
        await socket.accept()
        connection = Connection(socket)
        self.connections[identifier] = connection
        try:
            while True:
                await authorize()
                try:
                    frame = await asyncio.wait_for(socket.receive_json(), 15)
                except TimeoutError:
                    await authorize()
                    await self._send(connection, {"type": "keepalive"})
                    continue
                # 等待输入期间账号可能撤权；只有接收后的当前凭据能够授权此次写入。
                await authorize()
                if not isinstance(frame, dict):
                    raise DomainError(422, "invalid connector frame")
                identity = frame.get("id")
                method = frame.get("method")
                if isinstance(method, str):
                    params = frame.get("params", {})
                    if not isinstance(params, dict):
                        raise DomainError(422, "invalid notification")
                    result = await notify(method, params)
                    if identity is not None:
                        await self._send(
                            connection, {"jsonrpc": "2.0", "id": identity, "result": result}
                        )
                elif isinstance(identity, str) and identity in connection.pending:
                    future = connection.pending[identity]
                    if not future.done():
                        if "error" in frame:
                            future.set_exception(DomainError(409, "设备拒绝该操作"))
                        else:
                            future.set_result(frame.get("result"))
        except (WebSocketDisconnect, RuntimeError, DomainError, ValueError, TimeoutError):
            pass
        finally:
            if self.connections.get(identifier) is connection:
                await self.disconnect(identifier)

    async def close(self) -> None:
        """关闭应用时回收所有连接及等待中的 RPC。"""
        for identifier in list(self.connections):
            await self.disconnect(identifier)
