"""固定 DSH 的分集建议回调验收；真实引擎配受控无费用 SSE，不覆盖外部供应商。"""

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


async def test_real_dsh_series_suggestion_uses_draft_tool_without_confirmation(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    model = ControlledModels()
    response = await client.post(
        "/api/admin/models/connections",
        json={
            "name": "隔离短剧模型",
            "adapter": "openai-completions",
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": "synthetic",
        },
    )
    assert response.status_code == 200, response.text
    response = await client.post(
        "/api/admin/models/configurations",
        json={
            "name": "隔离短剧模型",
            "connectionId": response.json()["id"],
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
    response = await client.post(
        "/api/studio/series",
        json={
            "title": "真实引擎短剧编排",
            "plannedEpisodes": 2,
            "createEpisodeDrafts": True,
            "requestKey": "runtime-series",
        },
    )
    assert response.status_code == 200, response.text
    series = response.json()
    uri = "/api/studio/series/" + series["id"]
    response = await client.post(
        uri + "/proposals",
        json={
            "revision": series["revision"],
            "requestKey": "runtime-outline",
            "episodeIds": [ep["id"] for ep in series["episodes"]],
            "instruction": "补充每集梗概，保留其他故事段落",
        },
    )
    assert response.status_code == 200, response.text
    proposal = response.json()
    arguments = {
        "proposalId": proposal["id"],
        "episodes": [
            {"episodeId": ep["id"], "story": {**ep["story"], "synopsis": "受控建议-" + ep["title"]}}
            for ep in series["episodes"]
        ],
    }
    called: list[str] = []

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
                    if "proposalId" in fields(fields(tool.get("parameters")).get("properties"))
                ),
                None,
            )
            assert target, "真实 DSH 未安装短剧建议工具"
            called.append(str(target["name"]))
            yield model._chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "controlled-series-suggestion",
                            "type": "function",
                            "function": {
                                "name": target["name"],
                                "arguments": json.dumps(arguments, ensure_ascii=False),
                            },
                        }
                    ]
                }
            )
            yield model._chunk({}, "tool_calls")
        else:
            yield model._chunk({"content": "分集建议已提交，请对比采用。"})
            yield model._chunk({}, "stop")
        yield b"data: [DONE]\n\n"

    monkeypatch.setattr(app.state.services.model_proxy, "stream", stream)
    project_uri = "/api/studio/projects/" + proposal["projectId"]
    response = await client.post(project_uri + "/conversation")
    assert response.status_code == 200, response.text
    session = response.json()["sessionId"]
    response = await client.post(project_uri + "/conversation/runtime")
    assert response.status_code == 200, response.text
    async with asyncio.timeout(100):
        while True:
            runtime = (await client.get(project_uri + "/conversation/runtime")).json()["agent"]
            assert runtime["status"] != "error", runtime.get("error")
            if runtime["status"] == "running":
                break
            await asyncio.sleep(0.5)
    response = await client.post(
        f"/api/sessions/{session}/runtime/messages",
        json={
            "text": proposal["prompt"],
            "clientMessageId": uuid4().hex,
            "attachments": [],
            "selections": {},
        },
    )
    assert response.status_code == 200, response.text
    async with asyncio.timeout(90):
        while True:
            saved = (await client.get(uri + "/proposals")).json()[0]
            snapshot = (await client.get(f"/api/sessions/{session}/snapshot")).json()
            assert not snapshot.get("approvals"), "只保存分集建议不应要求第二次执行确认"
            assert snapshot["session"]["status"] != "error", snapshot
            if saved["state"] == "ready":
                assert saved["suggestions"] == arguments["episodes"]
                break
            await asyncio.sleep(0.5)
    assert len(called) == 1
    assert all(not ep["story"]["synopsis"] for ep in (await client.get(uri)).json()["episodes"])
    assert (await client.get("/api/studio/jobs")).json()["total"] == 0
