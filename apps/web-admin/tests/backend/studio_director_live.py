"""显式运行的真实导演会话验收。独立数据库和 Home，凭据仅由调用方注入内存。"""

import asyncio
import os
from uuid import uuid4

import pytest
from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient


@pytest.fixture
def platform_settings() -> dict[str, object]:
    origins = os.environ.get("STUDIO_ALLOWED_ORIGINS")
    return {"provider_allowed_origins": origins} if origins else {}


async def login_creator(client: AsyncClient) -> None:
    password = "Synthetic-director-123!"
    user = await client.post(
        "/api/admin/users",
        json={
            "username": "test-director",
            "displayName": "导演验收",
            "password": password,
            "roles": ["entertainment_creator"],
        },
    )
    assert user.status_code == 201, user.text
    creator = await complete_initial_login(client, "test-director", password)
    client.headers["Authorization"] = "Bearer " + str(creator["accessToken"])


async def ready_director(client: AsyncClient, project: str) -> str:
    """通过作品准备并等待真实 DSH；失败时保留监督器错误码用于定位。"""
    endpoint = f"/api/studio/projects/{project}/conversation"
    chat = await client.post(endpoint)
    assert chat.status_code == 200, chat.text
    prepared = await client.post(endpoint + "/runtime")
    assert prepared.status_code == 200, prepared.text
    async with asyncio.timeout(100):
        while True:
            current = (await client.get(endpoint + "/runtime")).json()["agent"]
            if current["status"] == "running":
                return str(chat.json()["sessionId"])
            assert current["status"] != "error", current.get("error")
            await asyncio.sleep(1)


async def test_creator_starts_bound_engine(platform: tuple[FastAPI, AsyncClient]) -> None:
    """只启动本机引擎，使用空供应商目录，不消耗模型额度。"""
    _, client = platform
    await bootstrap(client)
    await login_creator(client)
    assert (await client.post("/api/server-agent")).status_code == 403
    project = (await client.post("/api/studio/projects", json={"title": "创作者冷启"})).json()["id"]
    director = await ready_director(client, project)
    assert (await client.post(f"/api/studio/projects/{project}/conversation")).json()[
        "sessionId"
    ] == director


async def test_director_reads_bound_script(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    await bootstrap(client)
    response = await client.post(
        "/api/admin/models/connections",
        json={
            "name": "创作验收",
            "adapter": "openai-completions",
            "baseUrl": os.environ["STUDIO_BASE_URL"],
            "apiKey": os.environ["STUDIO_API_KEY"],
        },
    )
    assert response.status_code == 200
    connection = response.json()["id"]
    model = await client.post(
        "/api/admin/models/configurations",
        json={
            "name": "导演模型",
            "modelId": os.environ["STUDIO_CHAT_MODEL"],
            "capability": "chat",
            "connectionId": connection,
            "parameters": {"maxTokens": 2048},
        },
    )
    assert model.status_code == 200, model.text
    selected = await client.put(
        "/api/admin/models/defaults/chat",
        json={"configurationId": model.json()["id"], "revision": 0},
    )
    assert selected.status_code == 200, selected.text
    await login_creator(client)
    project = (await client.post("/api/studio/projects", json={"title": "导演绑定验收"})).json()[
        "id"
    ]
    phrase = "雨夜站台" + uuid4().hex[:8]
    assert (
        await client.put(
            f"/api/studio/projects/{project}",
            json={"revision": 1, "document": {"script": "本剧暗号为：" + phrase}},
        )
    ).status_code == 200
    sid = await ready_director(client, project)
    sent = await client.post(
        f"/api/sessions/{sid}/runtime/messages",
        json={
            "text": "调用读取作品工具，找出剧本中的暗号，然后原样回复该暗号。",
            "clientMessageId": uuid4().hex,
            "attachments": [],
        },
    )
    assert sent.status_code == 200, sent.text
    async with asyncio.timeout(130):
        while True:
            item = (await client.get(f"/api/sessions/{sid}/snapshot")).json()
            messages = item.get("timeline", {}).get("items", [])
            if any(
                phrase in str(m.get("content")) for m in messages if m.get("role") == "assistant"
            ):
                return
            if item.get("session", {}).get("status") == "error":
                pytest.fail("DSH 会话失败：" + str([m.get("type") for m in messages]))
            await asyncio.sleep(1)
