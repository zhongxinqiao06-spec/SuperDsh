"""真实回环 HTTP/WebSocket 受控 Connector，仅验证协议，不冒充真实设备覆盖。"""

import asyncio
import base64
import contextlib
import hashlib
import json
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

import uvicorn
from fastapi import FastAPI
from httpx import AsyncClient
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed


@asynccontextmanager
async def loopback_application(application: FastAPI) -> AsyncIterator[str]:
    """只绑定动态回环端口；fixture 已管理应用生命周期，本服务不重复初始化。"""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(application, lifespan="off", log_level="error", access_log=False)
    )
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 15)
        listener.close()


class ControlledConnector:
    """接收真实 JSON-RPC 和 Relay 帧，文件 PUT 走公开接口，记录请求用于合同断言。"""

    def __init__(self, origin: str, token: str) -> None:
        self.origin, self.token = origin, token
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.frames: list[dict[str, object]] = []
        self.tasks: list[asyncio.Task[None]] = []
        self.content = b"controlled-remote-file"
        self.upload_content: bytes | None = None
        self.upload_status: int | None = None
        self.output = ""
        self.sequence = 0

    async def run(self) -> None:
        async with connect(
            self.origin.replace("http:", "ws:") + "/api/connector/ws",
            additional_headers={"Authorization": "Bearer " + self.token},
        ) as socket:
            async for raw in socket:
                frame = json.loads(raw)
                method, params = (
                    str(frame.get("method", "")),
                    cast(dict[str, object], frame.get("params", {})),
                )
                if not method:
                    continue
                self.calls.append((method, params))
                result = await self.dispatch(method, params)
                await socket.send(
                    json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": result})
                )

    async def dispatch(self, method: str, params: dict[str, object]) -> object:
        if method == "fs.prepareDownload":
            return {
                "name": "remote.txt",
                "path": params["path"],
                "size": len(self.content),
                "sha256": hashlib.sha256(self.content).hexdigest(),
                "mediaType": "text/plain",
            }
        if method == "fs.uploadPreparedDownload":
            async with AsyncClient(base_url=self.origin) as client:
                response = await client.put(
                    str(params["uploadUrl"]),
                    params={"token": str(params["token"])},
                    content=self.content if self.upload_content is None else self.upload_content,
                    headers={"Authorization": "Bearer " + self.token},
                )
            self.upload_status = response.status_code
            return {"accepted": response.status_code == 200}
        if method == "fs.readText":
            return {
                "path": params["path"],
                "content": self.content.decode(),
                "sha256": hashlib.sha256(self.content).hexdigest(),
            }
        if method == "shell.exec":
            return {
                "stdout": "REMOTE_SHELL_OK",
                "stderr": "",
                "exitCode": 0,
                "timedOut": False,
            }
        if method == "terminal.create":
            return {
                "terminal": {
                    "terminalId": params["terminalId"],
                    "label": "远程验证终端",
                }
            }
        if method == "terminal.relay.connect":
            self.tasks.append(
                asyncio.create_task(self.relay(str(params["terminalId"]), str(params["token"])))
            )
            return {"accepted": True}
        if method in {"terminal.rename", "terminal.setPersistent"}:
            return {
                "terminal": {
                    "terminalId": params["terminalId"],
                    "label": params.get("label", "远程验证终端"),
                    "persistent": params.get("persistent", True),
                }
            }
        if method == "runtime.discover":
            return {
                "runtimeTypes": [
                    {
                        "runtimeType": "controlled",
                        "displayName": "受控运行端",
                        "maxInstances": 3,
                        "configSchema": {"type": "object"},
                    }
                ]
            }
        if method == "runtime.validateConfig":
            return {"valid": True}
        if method in {"runtime.start", "runtime.stop"}:
            return {"ok": True}
        if method == "runtime.modelCatalog":
            return {
                "models": [
                    {
                        "id": "controlled-model",
                        "selectionId": "controlled-model",
                        "displayName": "受控模型",
                    }
                ]
            }
        raise AssertionError("未登记的受控 RPC: " + method)

    async def relay(self, identifier: str, token: str) -> None:
        address = (
            self.origin.replace("http:", "ws:")
            + f"/api/connector/terminals/{identifier}/relay?token={token}"
        )
        try:
            async with connect(address) as socket:
                async for raw in socket:
                    frame = cast(dict[str, object], json.loads(raw))
                    self.frames.append(frame)
                    kind = frame["type"]
                    if kind == "start":
                        continue
                    if kind == "input":
                        self.output += base64.b64decode(str(frame["data"])).decode()
                        self.sequence += 1
                    result: dict[str, object] = {"ok": True}
                    if kind == "snapshot":
                        result = {
                            "dataBase64": base64.b64encode(self.output.encode()).decode(),
                            "seq": self.sequence,
                            "reset": False,
                        }
                    await socket.send(
                        json.dumps({"requestId": frame["requestId"], "result": result})
                    )
        except ConnectionClosed:
            pass

    async def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)


@asynccontextmanager
async def connector_peer(
    application: FastAPI, client: AsyncClient
) -> AsyncIterator[tuple[str, ControlledConnector]]:
    """设备创建与凭据交换走真实 API，关闭时回收全部回环连接。"""
    created = await client.post("/api/connectors", json={"name": "协议验证设备"})
    assert created.status_code == 200, created.text
    identifier = created.json()["connector"]["id"]
    secret = created.json()["connectorToken"]
    authenticated = await client.post(
        "/api/connector/auth",
        headers={"Authorization": f"Connector {identifier}:{secret}"},
    )
    assert authenticated.status_code == 200, authenticated.text
    async with loopback_application(application) as origin:
        peer = ControlledConnector(origin, authenticated.json()["accessToken"])
        task = asyncio.create_task(peer.run())
        try:
            async with asyncio.timeout(10):
                while identifier not in application.state.services.devices.channel.connections:
                    if task.done():
                        await task
                    await asyncio.sleep(0.01)
            yield identifier, peer
        finally:
            await peer.close()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, ConnectionClosed):
                await task
