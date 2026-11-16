"""真实资料引用事务和权限；模型边界使用受控结果，不调用收费供应商。"""

from dataclasses import replace
from io import BytesIO
from unittest.mock import AsyncMock

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.entity.do.asset_do import EntityVersionAsset
from app.modules.studio.entity.vo.director_context_vo import PrepareDirectorContext


async def test_director_context_snapshot_receipt_and_ownership(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    account = await app.state.services.identity.authenticate(client.headers["Authorization"][7:])
    project = (await client.post("/api/studio/projects", json={"title": "角色起草隔离验证"})).json()
    endpoint = "/api/studio/projects/" + project["id"]
    picture = BytesIO()
    Image.new("RGB", (8, 8), "orange").save(picture, "PNG")
    uploaded = await app.state.services.files.ingest(
        account, "角色.png", picture.getvalue(), "image/png"
    )
    personal = (
        await client.post(
            "/api/studio/assets",
            json={
                "kind": "character",
                "name": "个人库角色",
                "description": "原造型",
                "fileId": uploaded["id"],
            },
        )
    ).json()["id"]
    analysis = app.state.services.director_context.references
    monkeypatch.setattr(
        analysis,
        "inspect",
        AsyncMock(
            return_value={
                "vision": {
                    "available": True,
                    "name": "受控视觉",
                    "binding": {
                        "configurationId": "synthetic",
                        "revision": 1,
                        "capability": "vision.analyze",
                    },
                },
                "research": {"available": False, "binding": None},
            }
        ),
    )
    analyze = AsyncMock(return_value={"text": "橙色圆润的卡通形象", "sources": []})
    monkeypatch.setattr(analysis, "analyze", analyze)
    body = {
        "revision": project["revision"],
        "requestKey": "prepare-context",
        "assetIds": [personal],
        "uploads": [{"fileId": uploaded["id"], "name": "新参考形象"}],
        "analyzeImages": True,
    }
    response = await client.post(endpoint + "/director-context", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["revision"] > project["revision"]
    assert len(result["assetIds"]) == 2 and personal not in result["assetIds"]
    assert result["attachments"] == [] and "橙色圆润" in result["text"]
    assert (await client.post(endpoint + "/director-context", json=body)).json() == result
    analyze.assert_awaited_once()
    opened = (await client.get(endpoint)).json()
    assert opened["document"]["script"] == "" and opened["document"]["shots"] == []
    assert set(result["assetIds"]).issubset(opened["document"]["assets"])
    assert next(x for x in opened["assets"] if x["id"] == personal)["description"] == "原造型"
    with pytest.raises(DomainError) as denied:
        await app.state.services.director_context.prepare(
            replace(account, user_id="another-user"),
            project["id"],
            PrepareDirectorContext.model_validate(body),
        )
    assert denied.value.status == 404
    with pytest.raises(DomainError) as denied:
        await app.state.services.director_context.prepare(
            replace(
                account,
                permissions=tuple(p for p in account.permissions if p != "sessions.run"),
            ),
            project["id"],
            PrepareDirectorContext.model_validate(body),
        )
    assert denied.value.status == 403


async def test_failed_analysis_keeps_project_and_concurrent_edit(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    account = await app.state.services.identity.authenticate(client.headers["Authorization"][7:])
    project = (await client.post("/api/studio/projects", json={"title": "失败保护"})).json()
    endpoint = "/api/studio/projects/" + project["id"]
    picture = BytesIO()
    Image.new("RGB", (8, 8), "orange").save(picture, "PNG")
    file = await app.state.services.files.ingest(
        account, "参考.png", picture.getvalue(), "image/png"
    )
    analysis = app.state.services.director_context.references
    monkeypatch.setattr(
        analysis,
        "inspect",
        AsyncMock(
            return_value={
                "vision": {
                    "available": True,
                    "binding": {
                        "configurationId": "synthetic",
                        "revision": 1,
                        "capability": "vision.analyze",
                    },
                }
            }
        ),
    )
    monkeypatch.setattr(
        analysis, "analyze", AsyncMock(side_effect=DomainError(502, "受控模型故障"))
    )
    body = {
        "revision": project["revision"],
        "requestKey": "failed-context",
        "uploads": [{"fileId": file["id"], "name": "不应建空角色"}],
        "analyzeImages": True,
    }
    assert (await client.post(endpoint + "/director-context", json=body)).status_code == 502
    opened = (await client.get(endpoint)).json()
    assert opened["revision"] == project["revision"] and opened["assets"] == []

    async def changed(*args: object, **kwargs: object) -> dict:
        document = opened["document"]
        document["script"] = "用户刚写下的新故事"
        assert (
            await client.put(endpoint, json={"revision": project["revision"], "document": document})
        ).status_code == 200
        return {"text": "完成的参考图分析", "sources": []}

    monkeypatch.setattr(analysis, "analyze", changed)
    response = await client.post(
        endpoint + "/director-context",
        json={**body, "requestKey": "concurrent-context"},
    )
    assert response.status_code == 409
    current = (await client.get(endpoint)).json()
    assert current["document"]["script"] == "用户刚写下的新故事" and current["assets"] == []


@pytest.mark.parametrize("invalid", ["research", "maximum", "format", "pixels"])
async def test_all_context_inputs_are_checked_before_any_paid_operation(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch, invalid: str
) -> None:
    """第二能力不可用、混合来源超量及后续图片无效均不能先消耗第一张的模型费用。"""
    app, client = platform
    await bootstrap(client)
    account = await app.state.services.identity.authenticate(client.headers["Authorization"][7:])
    project = (await client.post("/api/studio/projects", json={"title": "收费前全量检查"})).json()
    endpoint = "/api/studio/projects/" + project["id"]
    picture = BytesIO()
    Image.new("RGB", (8, 8), "orange").save(picture, "PNG")
    first = await app.state.services.files.ingest(
        account, "首图.png", picture.getvalue(), "image/png"
    )
    second = await app.state.services.files.ingest(
        account, "后图.png", picture.getvalue(), "image/png"
    )
    personal = (
        await client.post(
            "/api/studio/assets",
            json={
                "kind": "character",
                "name": "已有角色",
                "fileId": second["id"],
            },
        )
    ).json()["id"]
    analysis = app.state.services.director_context.references
    monkeypatch.setattr(
        analysis,
        "inspect",
        AsyncMock(
            return_value={
                "vision": {
                    "available": True,
                    "maxImages": 1 if invalid == "maximum" else 4,
                    "binding": {
                        "configurationId": "vision",
                        "revision": 1,
                        "capability": "vision.analyze",
                    },
                },
                "research": {
                    "available": invalid != "research",
                    "binding": None
                    if invalid == "research"
                    else {"configurationId": "research", "revision": 1, "capability": "web.search"},
                },
            }
        ),
    )
    analyze, search = AsyncMock(), AsyncMock()
    monkeypatch.setattr(analysis, "analyze", analyze)
    monkeypatch.setattr(analysis, "search", search)
    if invalid == "pixels":
        monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1)
    if invalid == "format":
        original_read = app.state.services.files.read
        replacement = BytesIO()
        Image.new("RGB", (8, 8), "blue").save(replacement, "JPEG")

        async def changed_image(current: Account, identity: str) -> tuple[bytes, dict[str, object]]:
            content, metadata = await original_read(current, identity)
            return (replacement.getvalue() if identity == second["id"] else content, metadata)

        monkeypatch.setattr(app.state.services.files, "read", changed_image)
    response = await client.post(
        endpoint + "/director-context",
        json={
            "revision": project["revision"],
            "requestKey": "preflight-" + invalid,
            "uploads": [{"fileId": first["id"], "name": "新角色"}],
            "assetIds": [personal],
            "analyzeImages": True,
            "researchQuery": "海南旅游资料",
        },
    )
    assert response.status_code == (409 if invalid == "research" else 422), response.text
    analyze.assert_not_awaited()
    search.assert_not_awaited()
    opened = (await client.get(endpoint)).json()
    assert opened["revision"] == project["revision"] and opened["document"]["assets"] == []


async def test_multiple_reference_images_keep_independent_character_descriptions(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    """每张图只描述对应角色，查询失败后重试沿用各图稳定收据标识。"""
    app, client = platform
    await bootstrap(client)
    account = await app.state.services.identity.authenticate(client.headers["Authorization"][7:])
    project = (await client.post("/api/studio/projects", json={"title": "双角色描述"})).json()
    endpoint = "/api/studio/projects/" + project["id"]
    uploads, descriptions = [], {}
    for name, color in (("噜噜", "orange"), ("蓝猫", "blue")):
        picture = BytesIO()
        Image.new("RGB", (8, 8), color).save(picture, "PNG")
        content = picture.getvalue()
        file = await app.state.services.files.ingest(account, name + ".png", content, "image/png")
        uploads.append({"fileId": file["id"], "name": name})
        descriptions[content] = name + "的独立外观"
    analysis = app.state.services.director_context.references
    monkeypatch.setattr(
        analysis,
        "inspect",
        AsyncMock(
            return_value={
                key: {
                    "available": True,
                    "maxImages": 4,
                    "binding": {"configurationId": key, "revision": 1, "capability": capability},
                }
                for key, capability in (("vision", "vision.analyze"), ("research", "web.search"))
            }
        ),
    )
    seen: dict[str, tuple[str, bytes]] = {}

    async def describe(*args: object) -> dict:
        key, prompt, images = str(args[3]), str(args[5]), args[6]
        assert isinstance(images, list) and len(images) == 1
        content = images[0][0]
        if key in seen:
            assert seen[key] == (prompt, content)
        seen[key] = (prompt, content)
        return {"text": descriptions[content], "sources": [], "operationId": key}

    monkeypatch.setattr(analysis, "analyze", describe)
    search = AsyncMock(
        side_effect=[DomainError(502, "查询失败"), {"text": "已核实资料", "sources": []}]
    )
    monkeypatch.setattr(analysis, "search", search)
    body = {
        "revision": project["revision"],
        "requestKey": "independent-images",
        "uploads": uploads,
        "analyzeImages": True,
        "researchQuery": "海南资料",
    }
    assert (await client.post(endpoint + "/director-context", json=body)).status_code == 502
    assert (await client.get(endpoint)).json()["document"]["assets"] == []
    response = await client.post(endpoint + "/director-context", json=body)
    assert response.status_code == 200, response.text
    assert len(seen) == 2 and len({value[0] for value in seen.values()}) == 1
    result = response.json()
    assert len(result["evidence"]["vision"]["images"]) == 2
    opened = (await client.get(endpoint)).json()
    for upload in uploads:
        role = next(
            item
            for item in opened["assets"]
            if item["id"] in result["assetIds"] and item["name"] == upload["name"]
        )
        assert role["description"] == upload["name"] + "的独立外观"


async def test_library_image_becomes_project_character_and_four_shots_can_be_adopted(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """历史图片作为主角保留真实来源版本，四个五秒旁白镜头可比较采用。"""
    app, client = platform
    await bootstrap(client)
    account = await app.state.services.identity.authenticate(client.headers["Authorization"][7:])
    project = (await client.post("/api/studio/projects", json={"title": "噜噜去海南"})).json()
    endpoint = "/api/studio/projects/" + project["id"]
    picture = BytesIO()
    Image.new("RGB", (8, 8), "orange").save(picture, "PNG")
    file = await app.state.services.files.ingest(
        account, "噜噜.png", picture.getvalue(), "image/png"
    )
    source = (
        await client.post(
            "/api/studio/assets",
            json={
                "kind": "image",
                "name": "噜噜",
                "description": "个人库原图",
                "fileId": file["id"],
            },
        )
    ).json()["id"]
    body = {"revision": project["revision"], "requestKey": "select-character", "assetIds": [source]}
    response = await client.post(endpoint + "/director-context", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    role = result["assetIds"][0]
    assert role != source and role in result["text"]
    repeated = await client.post(
        endpoint + "/director-context",
        json={
            **body,
            "revision": result["revision"],
            "requestKey": "select-character-again",
        },
    )
    assert repeated.status_code == 200 and repeated.json()["assetIds"] == [role]
    opened = (await client.get(endpoint)).json()
    character = next(value for value in opened["assets"] if value["id"] == role)
    original = next(value for value in opened["assets"] if value["id"] == source)
    assert (character["kind"], character["fileId"], character["project"]) == (
        "character",
        file["id"],
        project["id"],
    )
    assert (
        original["kind"] == "image"
        and original["project"] is None
        and original["description"] == "个人库原图"
    )
    async with app.state.database.sessions() as session:
        assert (
            await session.scalar(
                select(EntityVersionAsset.asset_version_id).where(
                    EntityVersionAsset.entity_version_id == role,
                    EntityVersionAsset.purpose == "reference",
                )
            )
            == source
        )
    proposed = {
        **opened["document"],
        "script": "噜噜出发，看到椰树，走向海滩，告别海南。",
        "shots": [
            {
                "id": f"shot{index}",
                "action": action,
                "duration": 5000,
                "references": [role],
                "lines": [
                    {"id": f"line{index}", "role": role, "text": action, "start": 0, "end": 5000}
                ],
            }
            for index, action in enumerate(
                ("噜噜出发。", "椰树在招手。", "海风真舒服。", "再见海南。")
            )
        ],
    }
    response = await client.post(
        endpoint + "/proposals",
        json={
            "revision": opened["revision"],
            "requestKey": "four-shots",
            "document": proposed,
        },
    )
    assert response.status_code == 200, response.text
    proposal = response.json()["id"]
    comparison = (await client.get(endpoint + "/proposals/" + proposal)).json()
    response = await client.post(
        endpoint + "/proposals/" + proposal + "/review",
        json={
            "revision": comparison["revision"],
            "requestKey": "accept-four-shots",
            "selected": [change["key"] for change in comparison["changes"]],
        },
    )
    assert response.status_code == 200, response.text
    adopted = (await client.get(endpoint)).json()["document"]
    assert (
        len(adopted["shots"]) == 4 and sum(shot["duration"] for shot in adopted["shots"]) == 20000
    )
    assert all(shot["lines"][0]["role"] == role for shot in adopted["shots"])
