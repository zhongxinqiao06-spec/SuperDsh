"""每个 Host 独立的回环模型能力端点；撤权与停止会立即使能力失效。"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import secrets
import socket
from collections.abc import AsyncIterator, Iterator

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.modules.runtime.service.ports import Authorize, ModelProvider

from .protocol import FRAME_LIMIT, Fields, RuntimeFailure, fields


class CapabilityServer(uvicorn.Server):
    """回环能力服务不抢占所属 API 进程的信号处理器。"""

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        """关闭由监督器显式调用，进程信号由应用入口负责。"""
        yield


class ModelGateway:
    """只暴露目录和已授权模型路径，不转发登录令牌或供应商凭据。"""

    def __init__(self, owner: str, provider: ModelProvider, authorize: Authorize) -> None:
        self.owner = owner
        self.provider = provider
        self.authorize = authorize
        self.secret = secrets.token_urlsafe(48)
        self._scope: str | None = None
        self._providers: set[tuple[str, str]] = set()
        self._streams: set[asyncio.Task[object]] = set()
        self._closed = False
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[None] | None = None
        self._socket: socket.socket | None = None
        self._app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        self._app.add_api_route(
            "/{path:path}", self._handle, methods=["GET", "POST"], response_model=None
        )

    async def _handle(self, request: Request, path: str) -> JSONResponse | StreamingResponse:
        provided = request.headers.get("authorization", "")
        api_key = request.headers.get("x-api-key")
        valid = hmac.compare_digest(provided, f"Bearer {self.secret}") if provided else False
        if api_key is not None:
            valid = hmac.compare_digest(api_key, self.secret) and (valid or not provided)
        if self._closed or not valid:
            return JSONResponse({"detail": "Invalid model capability"}, status_code=401)
        try:
            await self.authorize(self.owner)
        except Exception:
            return JSONResponse({"detail": "Model authorization unavailable"}, status_code=403)
        if request.method == "GET" and path == "catalog" and not request.query_params:
            try:
                catalog = await self.provider.catalog(self.owner)
            except Exception:
                return JSONResponse({"detail": "Model catalog unavailable"}, status_code=503)
            scope = catalog.get("scope")
            self._scope = scope if isinstance(scope, str) else None
            providers = catalog.get("providers", [])
            self._providers = (
                {
                    (str(fields(item).get("providerId")), str(fields(item).get("protocol")))
                    for item in providers
                }
                if isinstance(providers, list)
                else set()
            )
            return JSONResponse(catalog, headers={"Cache-Control": "no-store"})
        # 来源、作用域与操作白名单先验证；不能用该能力请求任意地址。
        parts = path.split("/")
        if (
            request.method != "POST"
            or len(parts) < 6
            or parts[0] != "scopes"
            or self._scope is None
            or parts[1] != self._scope
            or parts[2] != "providers"
            or parts[4] not in {"openai-completions", "openai-responses", "anthropic-messages"}
            or (parts[3], parts[4]) not in self._providers
            or (
                request.url.query
                and not (parts[4] == "anthropic-messages" and request.url.query == "beta=true")
            )
            or "/".join(parts[5:])
            not in {"chat/completions", "responses", "messages", "v1/messages"}
        ):
            return JSONResponse({"detail": "Unknown model route"}, status_code=404)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > FRAME_LIMIT:
                return JSONResponse({"detail": "Model request too large"}, status_code=413)
        try:
            body = fields(json.loads(data))
        except (ValueError, TypeError, RuntimeFailure):
            return JSONResponse({"detail": "Invalid model request"}, status_code=422)
        return StreamingResponse(
            self._stream(path, body),
            media_type="text/event-stream" if body.get("stream") is True else "application/json",
        )

    async def _stream(self, path: str, body: Fields) -> AsyncIterator[bytes]:
        task = asyncio.current_task()
        if task is not None:
            self._streams.add(task)
        try:
            async for chunk in self.provider.stream(self.owner, path, body):
                if self._closed:
                    break
                await self.authorize(self.owner)
                yield chunk
        except asyncio.CancelledError:
            # 主动关闭能力时结束响应；原模型迭代器仍通过 finally 收到取消。
            return
        finally:
            if task is not None:
                self._streams.discard(task)

    async def start(self) -> str:
        """绑定随机回环端口，启动失败不得泄漏监听 socket。"""
        self._socket = socket.socket()
        self._socket.bind(("127.0.0.1", 0))
        self._socket.setblocking(False)
        port = self._socket.getsockname()[1]
        self._server = CapabilityServer(
            uvicorn.Config(self._app, log_level="error", access_log=False, lifespan="off")
        )
        self._task = asyncio.create_task(self._server.serve(sockets=[self._socket]))
        try:
            async with asyncio.timeout(10):
                while not self._server.started:
                    if self._task.done():
                        await self._task
                        raise RuntimeError("模型网关启动失败")
                    await asyncio.sleep(0.02)
        except BaseException:
            await self.close()
            raise
        return f"http://127.0.0.1:{port}"

    async def close(self) -> None:
        """先撤销能力，再停止所有连接；重复关闭无副作用。"""
        self._closed = True
        streams = list(self._streams)
        for task in streams:
            task.cancel()
        await asyncio.gather(*streams, return_exceptions=True)
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, 3)
            except (TimeoutError, asyncio.CancelledError):
                self._task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._task
        if self._socket is not None:
            self._socket.close()
