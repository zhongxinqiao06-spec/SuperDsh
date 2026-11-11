"""Python 直接接入固定产品 RuntimeBridge，不建立第二个 Agent 队列。"""

from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path

from .protocol import FRAME_LIMIT, Fields, Json, RuntimeFailure, contract, fields


class RuntimeBridge:
    """有界换行 JSON-RPC 通道；取消只撤销指定请求，事件消费不阻塞回包。"""

    def __init__(self) -> None:
        self.notifications: asyncio.Queue[Fields] = asyncio.Queue(maxsize=64)
        self.disconnected = asyncio.Event()
        self._pending: dict[str, asyncio.Future[Json]] = {}
        self._writer: asyncio.StreamWriter | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._serial = 0
        self._write_lock = asyncio.Lock()
        self.metadata = contract()

    async def connect(self, home: Path, connector_id: str, release: str) -> Fields:
        """仅连接自己 Home 的回环端点，并验证身份和固定协议。"""
        endpoint = fields(
            json.loads((home / "agents-anywhere/bridge/endpoint.json").read_text("utf-8"))
        )
        port = endpoint.get("port")
        if (
            endpoint.get("version") != self.metadata["endpointVersion"]
            or endpoint.get("host") != "127.0.0.1"
            or not isinstance(port, int)
            or isinstance(port, bool)
            or not 0 < port < 65536
            or not isinstance(endpoint.get("token"), str)
            or not endpoint["token"]
        ):
            raise RuntimeFailure("invalid_runtime_endpoint", "运行时端点无效")
        reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", port, limit=FRAME_LIMIT + 1), 10
        )
        self._reader_task = asyncio.create_task(self._receive(reader))
        try:
            result = fields(
                await self.request(
                    "initialize",
                    {
                        "authToken": endpoint["token"],
                        "protocolVersion": self.metadata["protocolVersion"],
                        "runtime": self.metadata["runtime"],
                        "connectorId": connector_id,
                        "sessionNamespace": connector_id,
                        "clientInfo": {"name": "superdsh-python-connector", "version": release},
                    },
                )
            )
            identity = fields(result.get("identity"))
            if (
                identity.get("runtime") != "dsh"
                or identity.get("protocolVersion") != self.metadata["protocolVersion"]
            ):
                raise RuntimeFailure("runtime_protocol_mismatch", "运行时协议不兼容")
            if fields(result.get("features")).get("syncMode") != "events":
                raise RuntimeFailure("runtime_sync_unavailable", "运行时缺少持久投影协议")
            return result
        except BaseException:
            await self.close()
            raise

    async def request(
        self, method: str, params: Fields | None = None, request_timeout: float = 60
    ) -> Json:
        """提交一次命令；超时结果未知，调用方不得生成新幂等键重放。"""
        if self.disconnected.is_set() or self._writer is None:
            raise RuntimeFailure("runtime_disconnected", "运行时连接不可用")
        self._serial += 1
        identifier = f"python-{self._serial}"
        future: asyncio.Future[Json] = asyncio.get_running_loop().create_future()
        self._pending[identifier] = future
        try:
            await self._write(
                {
                    "jsonrpc": self.metadata["jsonrpc"],
                    "id": identifier,
                    "method": method,
                    "params": params or {},
                }
            )
            return await asyncio.wait_for(future, request_timeout)
        except (asyncio.CancelledError, TimeoutError):
            with contextlib.suppress(RuntimeFailure, ConnectionError):
                await self._write(
                    {
                        "jsonrpc": self.metadata["jsonrpc"],
                        "method": "$/cancelRequest",
                        "params": {"id": identifier},
                    }
                )
            raise
        finally:
            self._pending.pop(identifier, None)

    async def _write(self, frame: Fields) -> None:
        data = (json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        if len(data) > FRAME_LIMIT:
            raise RuntimeFailure("runtime_frame_too_large", "运行时请求超出大小限制", 413)
        async with self._write_lock:
            if self._writer is None or self._writer.is_closing():
                raise RuntimeFailure("runtime_disconnected", "运行时连接不可用")
            self._writer.write(data)
            await self._writer.drain()

    async def _receive(self, reader: asyncio.StreamReader) -> None:
        try:
            while line := await reader.readline():
                if len(line) > FRAME_LIMIT:
                    raise RuntimeFailure("runtime_frame_too_large", "运行时帧过大")
                frame = fields(json.loads(line))
                if frame.get("jsonrpc") != self.metadata["jsonrpc"]:
                    raise RuntimeFailure("invalid_runtime_frame", "运行时协议帧无效")
                identifier = frame.get("id")
                method = frame.get("method")
                if isinstance(method, str):
                    if identifier is not None:
                        await self._write(
                            {
                                "jsonrpc": self.metadata["jsonrpc"],
                                "id": identifier,
                                "error": {"code": -32601, "message": "Unsupported request"},
                            }
                        )
                    else:
                        # 超载时断开并从持久 checkpoint 恢复，绝不丢事件后 ACK。
                        self.notifications.put_nowait(
                            {"method": method, "params": fields(frame.get("params", {}))}
                        )
                elif isinstance(identifier, str):
                    future = self._pending.get(identifier)
                    if future is None or future.done():
                        continue
                    if "error" in frame:
                        error = fields(frame["error"])
                        code = fields(error.get("data", {})).get("code", "runtime_request_failed")
                        future.set_exception(RuntimeFailure(str(code), "运行时拒绝该操作", 409))
                    else:
                        future.set_result(frame.get("result"))
                else:
                    raise RuntimeFailure("invalid_runtime_frame", "运行时协议帧无效")
        except (ConnectionError, ValueError, asyncio.QueueFull, RuntimeFailure):
            pass
        finally:
            self.disconnected.set()
            for pending in self._pending.values():
                if not pending.done():
                    pending.set_exception(RuntimeFailure("runtime_disconnected", "运行时已断开"))
            if self._writer is not None:
                self._writer.close()

    async def close(self) -> None:
        """关闭连接并释放所有等待者；可重复调用。"""
        self.disconnected.set()
        if self._writer is not None:
            self._writer.close()
            with contextlib.suppress(ConnectionError):
                await self._writer.wait_closed()
        if self._reader_task is not None and self._reader_task is not asyncio.current_task():
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader_task
