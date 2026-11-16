"""真实固定 DSH、冻结工具和回调验收；模型 SSE 使用无费用受控响应。"""

import asyncio
import json
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.integrations.dsh.protocol import Fields, fields
from fixtures.dsh_models import ControlledModels


async def test_real_dsh_text_suggestion_without_second_confirmation(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    connection = (
        await client.post(
            "/api/admin/models/connections",
            json={
                "name": "隔离编辑模型",
                "adapter": "openai-completions",
                "baseUrl": "https://api.deepseek.com/v1",
                "apiKey": "synthetic",
            },
        )
    ).json()["id"]
    response = await client.post(
        "/api/admin/models/configurations",
        json={
            "name": "隔离编辑模型",
            "connectionId": connection,
            "capability": "chat",
            "modelId": "controlled",
            "parameters": {"maxTokens": 2048},
        },
    )
    assert response.status_code == 200, response.text
    response = await client.put(
        "/api/admin/models/defaults/chat",
        json={"configurationId": response.json()["id"], "revision": 0},
    )
    assert response.status_code == 200, response.text
    project = (
        await client.post("/api/studio/projects", json={"title": "真实引擎局部改写"})
    ).json()["id"]
    uri = "/api/studio/projects/" + project
    saved = await client.put(
        uri, json={"revision": 1, "document": {"script": "开头。原句。结尾。"}}
    )
    edit = await client.post(
        uri + "/text-edits",
        json={
            "revision": saved.json()["revision"],
            "requestKey": "real-dsh",
            "scope": "selection",
            "start": 3,
            "end": 6,
            "instruction": "润色这一句",
        },
    )
    assert edit.status_code == 200, edit.text
    record = edit.json()
    model = ControlledModels()
    called = []

    async def stream(owner: str, path: str, body: Fields) -> AsyncIterator[bytes]:
        tools = body.get("tools", [])
        messages = json.dumps(body.get("messages", []), ensure_ascii=False)
        yield model._chunk({"role": "assistant"})
        if '"role": "tool"' not in messages:
            candidates = (
                [fields(fields(tool).get("function")) for tool in tools]
                if isinstance(tools, list)
                else []
            )
            target = next(
                (
                    tool
                    for tool in candidates
                    if "editId" in fields(fields(tool.get("parameters")).get("properties"))
                ),
                None,
            )
            assert target, "真实 DSH 未安装局部建议工具参数"
            called.append(str(target["name"]))
            yield model._chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "controlled-edit",
                            "type": "function",
                            "function": {
                                "name": target["name"],
                                "arguments": json.dumps(
                                    {"editId": record["id"], "replacement": "润色后的句子。"},
                                    ensure_ascii=False,
                                ),
                            },
                        }
                    ]
                }
            )
            yield model._chunk({}, "tool_calls")
        else:
            yield model._chunk({"content": "建议已提交，请对比采用。"})
            yield model._chunk({}, "stop")
        yield b"data: [DONE]\n\n"

    monkeypatch.setattr(app.state.services.model_proxy, "stream", stream)
    session = (await client.post(uri + "/conversation?purpose=text-edit")).json()["sessionId"]
    response = await client.post(uri + "/conversation/runtime?purpose=text-edit")
    assert response.status_code == 200, response.text
    async with asyncio.timeout(100):
        while True:
            state = (await client.get(uri + "/conversation/runtime?purpose=text-edit")).json()[
                "agent"
            ]
            assert state["status"] != "error", state.get("error")
            if state["status"] == "running":
                break
            await asyncio.sleep(0.5)
    sent = await client.post(
        f"/api/sessions/{session}/runtime/messages",
        json={
            "text": record["prompt"],
            "clientMessageId": uuid4().hex,
            "attachments": [],
            "selections": {},
        },
    )
    assert sent.status_code == 200, sent.text
    async with asyncio.timeout(90):
        while True:
            state = (await client.get(uri + "/text-edits")).json()[0]
            if state["state"] == "ready":
                assert state["suggestion"] == "润色后的句子。"
                break
            snapshot = (await client.get(f"/api/sessions/{session}/snapshot")).json()
            assert not snapshot.get("approvals"), "只保存建议不应要求第二次执行确认"
            assert snapshot["session"]["status"] != "error", snapshot
            await asyncio.sleep(0.5)
    assert called
    assert (await client.get(uri)).json()["document"]["script"] == "开头。原句。结尾。"
