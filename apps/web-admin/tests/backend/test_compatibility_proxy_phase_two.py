"""完整入口映射、模型代理撤权和供应商网络边界的第二阶段验证。"""

import asyncio
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import unquote
from uuid import uuid4

import httpx
import pytest
from conftest import bootstrap
from fastapi import APIRouter, FastAPI, WebSocket
from starlette.types import Message, Receive, Scope, Send

from app.api.compatibility import CompatibilityCatalog, CompatibilityMiddleware
from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport

ROOT = Path(__file__).resolve().parents[4]


def catalog(routes: list[dict[str, str]]) -> CompatibilityCatalog:
    """配置反例仅写本轮隔离验证目录，用完立即清理。"""
    path = Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]) / (uuid4().hex + ".json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"routes": routes}), encoding="utf-8")
    try:
        return CompatibilityCatalog(path)
    finally:
        path.unlink()


@pytest.mark.parametrize("transport,method", [("http", "POST"), ("websocket", "WEBSOCKET")])
async def test_multisegment_encoding_and_websocket_scope_are_preserved(
    transport: str,
    method: str,
) -> None:
    mapping = catalog(
        [
            {
                "transport": transport,
                "method": method,
                "legacy": "/legacy/models/{owner}/{operation:path}",
                "canonical": "/api/models/{owner}/{operation:path}",
            }
        ]
    )
    observed: list[Scope] = []
    messages: list[Message] = []

    async def downstream(scope: Scope, receive: Receive, send: Send) -> None:
        observed.append(scope)
        await send(await receive())

    async def receive() -> Message:
        return {"type": "websocket.receive", "bytes": b"unchanged"}

    async def send(message: Message) -> None:
        messages.append(message)

    raw = b"/legacy/models/user%252Fid/chat/completions"
    original: Scope = {
        "type": transport,
        "method": method,
        "path": unquote(raw.decode()),
        "raw_path": raw,
        "query_string": b"ticket=signed%2Fopaque&x=1&x=2",
        "headers": [
            (b"x-compatibility", b"attacker"),
            (b"sec-websocket-protocol", b"product"),
        ],
        "subprotocols": ["product"],
        "compatibility": {"original_path": "/forged"},
    }
    await CompatibilityMiddleware(downstream, mapping)(original, receive, send)
    result = observed[0]
    assert result["raw_path"] == b"/api/models/user%252Fid/chat/completions"
    assert result["path"] == "/api/models/user%2Fid/chat/completions"
    assert result["query_string"] == original["query_string"]
    assert result["headers"] == original["headers"] and result["subprotocols"] == ["product"]
    assert result["compatibility"] == {"original_path": raw.decode()}
    assert messages == [{"type": "websocket.receive", "bytes": b"unchanged"}]
    assert mapping.outward(
        result, "/api/models/user%252Fid/chat/completions?ticket=raw%2F", method
    ) == ("/legacy/models/user%252Fid/chat/completions?ticket=raw%2F")
    assert original["path"].startswith("/legacy")  # 不改变调用方持有的 scope。


def test_websocket_target_validation_uses_nested_router_and_transport() -> None:
    route = {
        "transport": "websocket",
        "method": "WEBSOCKET",
        "legacy": "/legacy/events/{identifier}",
        "canonical": "/api/events/{identifier}",
    }
    mapping = catalog([route])
    app = FastAPI()
    router = APIRouter()

    @router.websocket("/events/{identifier}")
    async def websocket(socket: WebSocket, identifier: str) -> None:
        await socket.close()

    app.include_router(router, prefix="/api")
    mapping.validate_targets(app.routes)
    with pytest.raises(ValueError, match="目标"):
        mapping.validate_targets({"/api/events/{identifier}": {"get": {}}})
    with pytest.raises(ValueError, match="参数"):
        catalog([{**route, "canonical": "/api/events/{identifier:path}"}])
    with pytest.raises(ValueError, match="重复"):
        catalog(
            [
                route,
                {
                    **route,
                    "legacy": "/legacy/events/{other}",
                    "canonical": "/api/events/{other}",
                },
            ]
        )


async def test_registered_compatibility_targets_and_frozen_contract_coverage(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, _ = platform
    mapping = app.state.compatibility
    mapping.validate_targets(app.routes)
    legacy = json.loads(
        (ROOT / "apps/admin/server/contracts/legacy-routes.json").read_text(encoding="utf-8")
    )
    missing = [
        f"{item['method']} {item['path']}"
        for item in legacy
        if not any(
            route.method == item["method"] and route.pattern.fullmatch(item["path"])
            for route in mapping.routes
        )
    ]
    assert not missing, "仍有旧入口未迁移，不可宣称功能无损：" + repr(missing)


@pytest.mark.parametrize("status", [200, 403])
@pytest.mark.parametrize("envelope", ["result", "terminal", "terminals"])
async def test_declared_response_envelope_only_wraps_success(status: int, envelope: str) -> None:
    """入口差异不侵入 handler；保留错误、重复响应头及分块 JSON。"""
    mapping = catalog(
        [
            {
                "transport": "http",
                "method": "GET",
                "legacy": "/legacy/terminal",
                "canonical": "/api/terminal",
                "responseEnvelope": envelope,
            }
        ]
    )
    payload = {"terminals": [{"id": "synthetic"}]} if status == 200 else {"detail": "forbidden"}
    raw = json.dumps(payload).encode()

    async def downstream(scope: Scope, receive: Receive, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(raw)).encode()),
                    (b"set-cookie", b"first=1"),
                    (b"set-cookie", b"second=2"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": raw[:5], "more_body": True})
        await send({"type": "http.response.body", "body": raw[5:]})

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(CompatibilityMiddleware(downstream, mapping)),
        base_url="http://fixture.invalid",
    ) as client:
        old = await client.get("/legacy/terminal")
        canonical = await client.get("/api/terminal")
    assert old.status_code == status and canonical.json() == payload
    if status != 200:
        assert old.json() == payload
    elif envelope == "result":
        assert old.json() == {"ok": True, "result": payload, "error": None}
    else:
        assert old.json()[envelope] == (
            payload["terminals"] if envelope == "terminals" else payload
        )
        assert old.json()["serverTime"]
    assert old.headers.get_list("set-cookie") == ["first=1", "second=2"]
    assert int(old.headers["content-length"]) == len(old.content)
    with pytest.raises(ValueError, match="响应封装"):
        catalog(
            [
                {
                    "transport": "websocket",
                    "method": "WEBSOCKET",
                    "legacy": "/old",
                    "canonical": "/new",
                    "responseEnvelope": "result",
                }
            ]
        )


class BlockingProvider(httpx.AsyncByteStream):
    """受控首块与长期等待，可验证撤权/取消最终释放供应商连接。"""

    def __init__(self) -> None:
        self.waiting = asyncio.Event()
        self.release = asyncio.Event()
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield b'data: {"text":"first"}\n\n'
        self.waiting.set()
        await self.release.wait()
        yield b"data: [DONE]\n\n"

    async def aclose(self) -> None:
        self.closed = True
        self.release.set()


async def provider_fixture(client: httpx.AsyncClient) -> tuple[str, str]:
    """仅创建临时数据库内的供应商和设备，实际网络全部由接收器替换。"""
    response = await client.post(
        "/api/admin/models/providers",
        json={
            "name": "代理测试供应商",
            "protocol": "openai-completions",
            "baseUrl": "https://fixture.invalid/api",
            "apiKey": "synthetic-secret",
            "models": [
                {
                    "modelId": "synthetic-chat",
                    "name": "代理测试",
                    "contextWindow": 32000,
                    "maxTokens": 1024,
                    "inputTypes": ["text"],
                }
            ],
            "enabled": True,
        },
    )
    assert response.status_code == 200, response.text
    device = await client.post("/api/connectors", json={"name": "代理测试设备"})
    assert device.status_code == 200, device.text
    return response.json()["providerId"], device.json()["connector"]["id"]


async def test_proxy_legacy_operation_secret_filtering_and_upstream_status(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)
    provider, device = await provider_fixture(client)
    captured: list[httpx.Request] = []
    status = 200

    async def receiver(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            status,
            json={"id": "fixture-answer"} if status == 200 else {"secret": "never-echo"},
        )

    app.state.services.models.transport = ProviderTransport(transport=httpx.MockTransport(receiver))
    headers = {
        "x-superdsh-connector-id": device,
        "x-api-key": "untrusted-client-secret",
    }
    body = {
        "model": "synthetic-chat",
        "messages": [{"role": "user", "content": "hello"}],
    }
    for base in ("/api", "/api/v2"):
        response = await client.post(
            f"{base}/models/{provider}/openai-completions/chat/completions",
            json=body,
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json() == {"id": "fixture-answer"}
    assert captured[0].url == "https://fixture.invalid/api/chat/completions"
    assert captured[0].headers["authorization"] == "Bearer synthetic-secret"
    assert "x-api-key" not in captured[0].headers and "cookie" not in captured[0].headers
    status = 429
    response = await client.post(
        f"/api/models/{provider}/openai-completions/chat/completions",
        json=body,
        headers=headers,
    )
    assert response.status_code == 429 and "never-echo" not in response.text
    before = len(captured)
    assert (
        await client.post(
            f"/api/models/{provider}/openai-completions/admin/delete",
            json=body,
            headers=headers,
        )
    ).status_code == 404
    assert len(captured) == before


async def test_proxy_single_session_revocation_interrupts_waiting_stream_and_closes_connection(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    provider, device = await provider_fixture(client)
    stream = BlockingProvider()

    async def receiver(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    app.state.services.models.transport = ProviderTransport(transport=httpx.MockTransport(receiver))
    identity = app.state.services.identity
    token = str(login["accessToken"])
    account = await identity.authenticate(token)
    iterator = app.state.services.model_proxy.forward(
        account,
        provider,
        "openai-completions",
        "chat/completions",
        {"model": "synthetic-chat", "stream": True},
        device,
        access_token=token,
    )
    assert b"first" in await anext(iterator)
    waiting = asyncio.create_task(anext(iterator))
    try:
        await asyncio.wait_for(stream.waiting.wait(), 3)
        await identity.revoke_session(account, account.session_id)
        with pytest.raises(DomainError) as failure:
            await asyncio.wait_for(waiting, 5)
        assert failure.value.status == 403
        assert stream.closed
    finally:
        if not waiting.done():
            waiting.cancel()
        await iterator.aclose()


async def test_provider_rejects_private_targets_redirects_and_malformed_json() -> None:
    transport = ProviderTransport()
    with pytest.raises(DomainError) as denied:
        await transport._target("http://127.0.0.1/private", {})
    assert denied.value.status == 403

    async def redirect(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "http://127.0.0.1/secret"})

    with pytest.raises(DomainError):
        await ProviderTransport(transport=httpx.MockTransport(redirect)).request(
            "GET", "https://fixture.invalid", {}
        )

    async def malformed(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not-json")

    with pytest.raises(DomainError) as malformed_error:
        await ProviderTransport(transport=httpx.MockTransport(malformed)).request(
            "GET", "https://fixture.invalid", {}
        )
    assert malformed_error.value.status == 502
