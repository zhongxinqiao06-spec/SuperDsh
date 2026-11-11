"""Bridge 传输反例；这里是协议测试，不能代替真实固定 Host 验证。"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.integrations.dsh.bridge import RuntimeBridge
from app.integrations.dsh.process import child_environment
from app.integrations.dsh.protocol import Fields, RuntimeFailure, contract
from app.integrations.dsh.sync import ProjectionSync


def test_child_environment_does_not_inherit_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """只有短期能力进入子进程，数据库/登录/供应商凭据和 Node 注入配置均排除。"""
    for key in (
        "DATABASE_URL",
        "WEB_ADMIN_SECRET",
        "OPENAI_API_KEY",
        "NODE_OPTIONS",
        "PYTHONPATH",
    ):
        monkeypatch.setenv(key, "synthetic-must-not-inherit")
    environment = child_environment(
        tmp_path / "home",
        tmp_path / "workspace",
        tmp_path / "anchor.json",
        {"origin": "http://127.0.0.1:1234", "secret": "short-lived"},
    )
    assert not any(value == "synthetic-must-not-inherit" for value in environment.values())
    assert environment["DSH_HOME"] == str(tmp_path / "home")
    assert json.loads(environment["SUPERDSH_MODEL_GATEWAY"])["secret"] == "short-lived"


@pytest.mark.asyncio
async def test_bridge_timeout_cancels_only_its_request(tmp_path: Path) -> None:
    """请求超时发送原 ID 的取消通知，其他 RPC 仍能返回。"""
    metadata = contract()
    cancelled = asyncio.Event()
    connections: list[asyncio.Task[None]] = []

    async def accept(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        connections.append(task)
        try:
            while line := await reader.readline():
                frame = json.loads(line)
                if frame.get("method") == "$/cancelRequest":
                    cancelled.set()
                    continue
                if frame["method"] == "hang":
                    continue
                result = (
                    {
                        "identity": {
                            "runtime": metadata["runtime"],
                            "protocolVersion": metadata["protocolVersion"],
                        },
                        "features": {"syncMode": "events"},
                    }
                    if frame["method"] == "initialize"
                    else {"ok": True}
                )
                writer.write(
                    (
                        json.dumps(
                            {
                                "jsonrpc": metadata["jsonrpc"],
                                "id": frame["id"],
                                "result": result,
                            }
                        )
                        + "\n"
                    ).encode()
                )
                await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(accept, "127.0.0.1", 0)
    endpoint = tmp_path / "agents-anywhere/bridge/endpoint.json"
    endpoint.parent.mkdir(parents=True)
    endpoint.write_text(
        json.dumps(
            {
                "version": metadata["endpointVersion"],
                "host": "127.0.0.1",
                "port": server.sockets[0].getsockname()[1],
                "token": "synthetic-token",
            }
        ),
        "utf-8",
    )
    bridge = RuntimeBridge()
    try:
        await bridge.connect(tmp_path, "synthetic-connector", "synthetic-release")
        with pytest.raises(TimeoutError):
            await bridge.request("hang", request_timeout=0.05)
        await asyncio.wait_for(cancelled.wait(), 1)
        assert await bridge.request("ping") == {"ok": True}
    finally:
        await bridge.close()
        server.close()
        await server.wait_closed()
        await asyncio.gather(*connections)


@pytest.mark.asyncio
async def test_bridge_rejects_non_loopback_endpoint(tmp_path: Path) -> None:
    """磁盘端点不能将受限能力令牌带到外部地址。"""
    endpoint = tmp_path / "agents-anywhere/bridge/endpoint.json"
    endpoint.parent.mkdir(parents=True)
    endpoint.write_text(
        json.dumps(
            {
                "version": contract()["endpointVersion"],
                "host": "192.0.2.1",
                "port": 1234,
                "token": "synthetic-token",
            }
        ),
        "utf-8",
    )
    with pytest.raises(RuntimeFailure) as failure:
        await RuntimeBridge().connect(tmp_path, "synthetic", "synthetic-release")
    assert failure.value.code == "invalid_runtime_endpoint"


class FailedStore:
    """模拟磁盘或数据库提交失败，仅用于确认 ACK 顺序。"""

    async def commit(self, owner: str, batch: Fields) -> Fields:
        raise OSError("synthetic storage unavailable")

    async def events(self, owner: str, after: int = 0) -> list[Fields]:
        return []

    async def reserve(self, owner: str, identifier: str, digest: str) -> tuple[bool, None]:
        return True, None

    async def settle(self, owner: str, identifier: str, result: object) -> None:
        return None


@pytest.mark.asyncio
async def test_projection_storage_failure_never_acknowledges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """状态持久化失败时断开，不能 ACK 或宣告 Connector 就绪。"""
    bridge = RuntimeBridge()
    calls: list[str] = []

    async def request(
        method: str, params: Fields | None = None, request_timeout: float = 60
    ) -> Fields:
        calls.append(method)
        return {
            "streamId": "synthetic-stream",
            "projectionVersion": contract()["projectionVersion"],
        }

    monkeypatch.setattr(bridge, "request", request)
    sync = ProjectionSync(bridge, FailedStore(), "synthetic-owner")
    await sync.start()
    await bridge.notifications.put(
        {
            "method": "runtime.sync.batch",
            "params": {
                "streamId": "synthetic-stream",
                "batchSeq": 1,
                "projectionVersion": contract()["projectionVersion"],
                "operations": [
                    {
                        "kind": "notifications",
                        "notifications": [
                            {
                                "method": "session.inventory.complete",
                                "params": {"complete": True},
                            }
                        ],
                    }
                ],
            },
        }
    )
    assert sync.task is not None
    with pytest.raises(OSError):
        await sync.task
    assert calls == ["runtime.sync.subscribe"]
    assert bridge.disconnected.is_set()
    assert not sync.ready.is_set()
    await sync.close()
