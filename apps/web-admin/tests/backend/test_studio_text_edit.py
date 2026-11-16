"""局部编辑真实接口：范围、并发、幂等、撤回及旧分镜保留。"""

from copy import deepcopy
from dataclasses import replace

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.infrastructure.errors import DomainError
from app.modules.studio.entity.bo.text_span import relocate


async def project(client: AsyncClient) -> tuple[str, dict]:
    response = await client.post("/api/studio/projects", json={"title": "AI 编辑隔离作品"})
    uri = "/api/studio/projects/" + response.json()["id"]
    document = {
        "script": "开头。\n噜噜说：你好，海南。\n结尾。",
        "scenes": [
            {
                "id": "scene-a",
                "title": "海边",
                "synopsis": "来到海边",
                "scriptRange": {"start": 4, "end": 15},
            },
        ],
        "shots": [{"id": "shot-a", "sceneId": "scene-a", "action": "手工镜头", "trimStart": 1000}],
        "assets": [],
    }
    response = await client.put(uri, json={"revision": 1, "document": document})
    assert response.status_code == 200, response.text
    return uri, (await client.get(uri)).json()


async def suggest(app: FastAPI, client: AsyncClient, uri: str, edit: str, text: str) -> None:
    # 通过真实 StudioAgent 工具分发，DSH 供应商执行本用例用受控回执代替。
    account = await app.state.services.identity.authenticate(client.headers["Authorization"][7:])
    session = (await client.post(uri + "/conversation?purpose=text-edit")).json()["sessionId"]
    await app.state.services.extensions.execute(
        account,
        {
            "sourceId": "starbridge.text-edit",
            "toolId": "studio_text_suggest",
            "version": app.state.services.extensions.builtins["starbridge.text-edit"]["version"],
        },
        {"editId": edit, "replacement": text},
        {},
        {"sessionId": session, "receiptId": "test-tool-" + edit},
    )


async def test_text_edit_apply_undo_and_conflict(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    await bootstrap(client)
    uri, p = await project(client)
    body = {
        "revision": p["revision"],
        "requestKey": "edit-1",
        "scope": "scene",
        "sceneId": "scene-a",
        "start": 4,
        "end": 15,
        "instruction": "对白更自然",
    }
    response = await client.post(uri + "/text-edits", json=body)
    assert response.status_code == 200, response.text
    edit = response.json()["id"]
    assert (await client.post(uri + "/text-edits", json=body)).json()["id"] == edit
    await suggest(app, client, uri, edit, "噜噜说：海风真舒服。")
    manual = deepcopy(p["document"])
    manual["script"] += "\n片尾署名。"
    manual["shots"][0]["action"] = "手工镜头保留"
    save = (await client.put(uri, json={"revision": p["revision"], "document": manual})).json()
    operation = {
        "revision": save["revision"],
        "requestKey": "apply",
        "action": "apply",
        "replacement": "噜噜说：海风真舒服，一起走吧。",
    }
    response = await client.post(uri + f"/text-edits/{edit}/resolve", json=operation)
    assert response.status_code == 200, response.text
    assert (
        await client.post(uri + f"/text-edits/{edit}/resolve", json=operation)
    ).json() == response.json()
    current = (await client.get(uri)).json()
    assert current["document"]["script"].endswith("片尾署名。")
    assert "海风真舒服" in current["document"]["script"]
    assert current["document"]["adaptationMode"] == "original"
    assert current["document"]["shots"][0]["action"] == "手工镜头保留"
    assert current["document"]["shots"][0]["trimStart"] == 1000
    assert (await client.get(uri + "/text-edits")).json()[0]["suggestion"] == operation[
        "replacement"
    ]
    operation = {"revision": current["revision"], "requestKey": "undo", "action": "undo"}
    response = await client.post(uri + f"/text-edits/{edit}/resolve", json=operation)
    assert response.status_code == 200, response.text
    final = (await client.get(uri)).json()
    assert final["document"]["script"] == manual["script"]
    assert (await client.get(uri + "/text-edits")).json()[0]["state"] == "undone"


async def test_cancel_conflict_and_project_boundary(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    await bootstrap(client)
    uri, p = await project(client)
    response = await client.post(
        uri + "/text-edits",
        json={
            "revision": p["revision"],
            "requestKey": "edit-2",
            "scope": "selection",
            "start": 4,
            "end": 15,
            "instruction": "润色",
        },
    )
    edit = response.json()["id"]
    await suggest(app, client, uri, edit, "新的台词")
    manual = deepcopy(p["document"])
    manual["script"] = manual["script"].replace("海南", "上海")
    revision = (await client.put(uri, json={"revision": p["revision"], "document": manual})).json()[
        "revision"
    ]
    assert (await client.get(uri + "/text-edits")).json()[0]["conflict"]
    response = await client.post(
        uri + f"/text-edits/{edit}/resolve",
        json={"revision": revision, "requestKey": "conflict", "action": "apply"},
    )
    assert response.status_code == 409
    other, q = await project(client)
    assert (
        await client.post(
            other + f"/text-edits/{edit}/resolve",
            json={"revision": q["revision"], "requestKey": "cross", "action": "discard"},
        )
    ).status_code == 404
    assert (
        await client.post(
            uri + f"/text-edits/{edit}/resolve",
            json={"revision": revision, "requestKey": "discard", "action": "discard"},
        )
    ).status_code == 200
    with pytest.raises(DomainError):
        await suggest(app, client, uri, edit, "迟到结果")
    assert (await client.get(uri)).json()["document"] == manual


async def test_text_edit_permissions_and_scene_relink(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)
    uri, p = await project(client)
    account = await app.state.services.identity.authenticate(client.headers["Authorization"][7:])
    service = app.state.services.studio.text_edits
    from app.modules.studio.entity.vo.text_edit_vo import CreateTextEdit

    body = CreateTextEdit(
        revision=p["revision"],
        requestKey="permissions",
        scope="scene",
        sceneId="scene-a",
        start=4,
        end=15,
        instruction="润色",
    )
    for denied in ("products.entertainment", "studio.projects.write", "sessions.run"):
        with pytest.raises(DomainError) as result:
            await service.create(
                replace(account, permissions=tuple(x for x in account.permissions if x != denied)),
                p["id"],
                body,
            )
        assert result.value.status == 403
    with pytest.raises(DomainError) as result:
        await service.list(replace(account, user_id="another-account"), p["id"])
    assert result.value.status == 404
    edit = (await client.post(uri + "/text-edits", json=body.model_dump())).json()["id"]
    await suggest(app, client, uri, edit, "新句子")
    manual = deepcopy(p["document"])
    manual["scenes"][0]["scriptRange"] = {"start": 0, "end": 3}
    revision = (await client.put(uri, json={"revision": p["revision"], "document": manual})).json()[
        "revision"
    ]
    assert (await client.get(uri + "/text-edits")).json()[0]["conflict"]
    assert (
        await client.post(
            uri + f"/text-edits/{edit}/resolve",
            json={"revision": revision, "requestKey": "relinked", "action": "apply"},
        )
    ).status_code == 409


def test_repeated_text_and_unicode_are_not_search_replaced() -> None:
    assert relocate("😀开头甲乙结束", "新增😀开头甲乙结束", 4, 6) == (6, 8)
    with pytest.raises(DomainError):
        relocate("你好。你好。", "新增你好。你好。", 3, 6)
