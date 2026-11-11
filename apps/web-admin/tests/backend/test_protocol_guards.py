"""集中映射、流输入上限和初始化时效的反例测试。"""

import json
import os
from pathlib import Path
from uuid import uuid4

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from starlette.types import Message, Receive, Scope, Send

from app.api.body_limit import BodyLimitMiddleware
from app.api.compatibility import CompatibilityCatalog


def catalog_file(routes: list[dict[str, str]]) -> Path:
    """反例数据只写本轮验证目录。"""
    path = Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]) / (uuid4().hex + ".json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"routes": routes}), encoding="utf-8")
    return path


def test_mapping_rejects_ambiguous_and_missing_targets() -> None:
    first = {
        "method": "GET",
        "transport": "http",
        "legacy": "/legacy/{id}",
        "canonical": "/api/resource/{id}",
    }
    path = catalog_file(
        [
            first,
            {
                **first,
                "legacy": "/legacy/{another}",
                "canonical": "/api/resource/{another}",
            },
        ]
    )
    try:
        with pytest.raises(ValueError, match="重复"):
            CompatibilityCatalog(path)
    finally:
        path.unlink()
    path = catalog_file([{**first, "canonical": "/api/resource/{wrong}"}])
    try:
        with pytest.raises(ValueError, match="参数"):
            CompatibilityCatalog(path)
    finally:
        path.unlink()
    path = catalog_file([first])
    try:
        with pytest.raises(ValueError, match="目标"):
            CompatibilityCatalog(path).validate_targets({})
    finally:
        path.unlink()


async def test_chunked_limit_does_not_trust_content_length() -> None:
    messages: list[Message] = [
        {"type": "http.request", "body": b"123456", "more_body": True},
        {"type": "http.request", "body": b"789012", "more_body": False},
    ]
    outputs: list[Message] = []
    called = False

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        nonlocal called
        called = True

    async def receive() -> Message:
        return messages.pop(0)

    async def send(value: Message) -> None:
        outputs.append(value)

    await BodyLimitMiddleware(app, limit=10)(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/resource",
            "headers": [(b"content-length", b"0")],
        },
        receive,
        send,
    )
    assert not called
    assert outputs[0]["status"] == 413


async def test_auth_boundaries_and_canonical_legacy_equivalence(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    current = await client.get("/api/auth/me")
    legacy = await client.get("/api/v2/auth/me")
    canonical_data, legacy_data = current.json(), legacy.json()
    canonical_data.pop("serverTime")
    legacy_data.pop("serverTime")
    assert canonical_data == legacy_data
    assert (
        await client.get("/api/auth/me", headers={"Authorization": "Bearer invalid"})
    ).status_code == 401
    assert (
        await client.post(
            "/api/auth/refresh", json={}, headers={"Origin": "https://attacker.invalid"}
        )
    ).status_code == 403
    assert (await client.delete("/api/admin/users/" + str(login["userId"]))).status_code == 409
    assert (await client.get("/api/does-not-exist")).status_code == 404
    assert (
        await client.get("/api/auth/config", headers={"X-Compatibility": "legacy"})
    ).status_code == 200
    assert (
        await client.post(
            "/api/oauth/token",
            content=b"malformed",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    ).status_code == 422
    # 管理登录只初始化配置，运行状态依旧未准备，不启动 Host。
    state = await app.state.services.runtime.view(str(login["userId"]))
    assert state["status"] != "ready"
