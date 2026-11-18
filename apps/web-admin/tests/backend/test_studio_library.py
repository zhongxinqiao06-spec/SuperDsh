"""隔离 PostgreSQL 验证收藏、复用、造型和三方更新，不使用真实作品或供应商。"""

import asyncio
import wave
from dataclasses import replace
from io import BytesIO
from uuid import uuid4

import pytest
from conftest import bootstrap
from fastapi import FastAPI, Request
from httpx import AsyncClient
from PIL import Image

from app.api import dependencies
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.entity.bo.library_changes import compare_fields
from app.modules.studio.entity.do.asset_do import EntityVersion
from app.modules.studio.entity.do.models import MediaJob

ROOT = "/api/studio"


def test_library_changes_never_offer_local_only_edits_as_updates() -> None:
    base = {
        "kind": "character",
        "name": "小白",
        "description": "基础设定",
        "fileId": "old-picture",
        "voice": "same",
    }
    local = {**base, "description": "本片戴太阳帽"}
    remote = {**base, "fileId": "new-picture"}
    fields = {field["key"]: field for field in compare_fields(base, local, remote)}
    assert fields["description"]["localChanged"]
    assert not fields["description"]["changed"] and not fields["description"]["conflict"]
    assert fields["appearance"]["changed"] and not fields["appearance"]["conflict"]


async def post(client: AsyncClient, path: str, value: dict) -> dict:
    response = await client.post(ROOT + path, json=value)
    assert response.status_code == 200, response.text
    return response.json()


async def save(client: AsyncClient, project: dict, document: dict) -> dict:
    response = await client.put(
        ROOT + "/projects/" + project["id"],
        json={
            "revision": project["revision"],
            "document": document,
        },
    )
    assert response.status_code == 200, response.text
    return {**project, **response.json()}


async def test_library_collect_reuse_conflict_and_variant_isolation(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client)
    work = await post(client, "/projects", {"title": "原太空旅行"})
    role = await post(
        client,
        "/assets",
        {
            "kind": "character",
            "name": "小白",
            "description": "原始白色造型",
            "voice": "voice-a",
            "project": work["id"],
        },
    )
    work = await save(
        client,
        work,
        {
            "assets": [role["id"]],
            "shots": [
                {
                    "id": "first",
                    "action": "出发",
                    "references": [role["id"]],
                    "lines": [{"id": "line", "role": role["id"], "text": "出发啦"}],
                }
            ],
        },
    )
    collected = await post(
        client,
        "/library/collections",
        {"sourceVersionId": role["id"], "requestKey": "collect-first", "mode": "new"},
    )
    work = (await client.get(ROOT + f"/projects/{work['id']}")).json()
    library = collected["asset"]
    assert collected["created"] and library["project"] is None and library["voice"] == "voice-a"
    duplicate = await post(
        client,
        "/library/collections",
        {"sourceVersionId": role["id"], "requestKey": "collect-second", "mode": "new"},
    )
    assert duplicate["asset"]["id"] == library["id"] and not duplicate["created"]
    detail = (await client.get(ROOT + f"/library/{role['id']}/detail")).json()
    assert detail["origin"]["family"] == library["family"]
    assert (await client.get(ROOT + "/library", params={"category": "characters"})).json()[
        "total"
    ] == 1

    second = await post(client, "/projects", {"title": "海边旅行"})
    imported = await post(
        client,
        f"/projects/{second['id']}/library-imports",
        {
            "sourceVersionId": library["id"],
            "requestKey": "import-one",
            "expectedRevision": second["revision"],
        },
    )
    replay = await post(
        client,
        f"/projects/{second['id']}/library-imports",
        {
            "sourceVersionId": library["id"],
            "requestKey": "import-one",
            "expectedRevision": second["revision"],
        },
    )
    assert replay == imported
    second.update(imported)
    local_id = imported["assetId"]
    second = await save(
        client,
        second,
        {
            "assets": [local_id],
            "shots": [
                {
                    "id": "beach",
                    "action": "吹海风",
                    "references": [local_id],
                    "lines": [
                        {
                            "id": "hello",
                            "role": local_id,
                            "text": "海风真好",
                            "start": 125,
                            "subtitle": "海风真好！",
                        }
                    ],
                }
            ],
        },
    )
    local = await post(
        client,
        "/assets",
        {
            "kind": "character",
            "name": "小白",
            "description": "本片戴太阳帽",
            "voice": "voice-a",
            "project": second["id"],
            "parent": local_id,
        },
    )
    second = await save(
        client,
        second,
        {
            **second["document"],
            "assets": [local["id"]],
            "shots": [
                {
                    **second["document"]["shots"][0],
                    "references": [local["id"]],
                    "lines": [
                        {
                            **second["document"]["shots"][0]["lines"][0],
                            "role": local["id"],
                        }
                    ],
                }
            ],
        },
    )
    updated = await post(
        client,
        "/assets",
        {
            "kind": "character",
            "name": "小白",
            "description": "库内增加红领巾",
            "voice": "voice-b",
            "parent": library["id"],
        },
    )
    preview = await post(
        client,
        f"/projects/{second['id']}/library-updates/preview",
        {"assetId": local["id"]},
    )
    fields = {field["key"]: field for field in preview["fields"]}
    assert fields["description"]["conflict"] and fields["voice"]["changed"]
    assert preview["affected"] == {
        "shots": [{"id": "beach", "number": 1}],
        "lines": [{"id": "hello", "shotId": "beach"}],
    }
    apply = {
        "assetId": local["id"],
        "sourceVersionId": updated["id"],
        "expectedRevision": second["revision"],
        "requestKey": "merge",
        "fields": ["description"],
    }
    assert (
        await client.post(ROOT + f"/projects/{second['id']}/library-updates/apply", json=apply)
    ).status_code == 409
    result = await post(
        client,
        f"/projects/{second['id']}/library-updates/apply",
        {**apply, "fields": ["voice"]},
    )
    adopted = next(asset for asset in result["assets"] if asset["id"] == result["assetId"])
    assert adopted["voice"] == "voice-b" and adopted["description"] == "本片戴太阳帽"
    assert result["document"]["shots"][0]["lines"][0]["start"] == 125
    assert result["document"]["shots"][0]["lines"][0]["subtitle"] == "海风真好！"
    remaining = await post(
        client,
        f"/projects/{second['id']}/library-updates/preview",
        {"assetId": result["assetId"]},
    )
    pending = {field["key"]: field for field in remaining["fields"]}
    assert pending["description"]["changed"] and pending["description"]["conflict"]
    assert not pending["voice"]["changed"]
    assert adopted["origin"]["hasUpdates"]
    merged = await post(
        client,
        f"/projects/{second['id']}/library-updates/apply",
        {
            "assetId": result["assetId"],
            "sourceVersionId": updated["id"],
            "expectedRevision": result["revision"],
            "requestKey": "merge-second-field",
            "fields": ["description"],
            "overwriteConflicts": True,
        },
    )
    complete = next(item for item in merged["assets"] if item["id"] == merged["assetId"])
    assert complete["description"] == "库内增加红领巾" and complete["voice"] == "voice-b"
    assert not complete["origin"]["hasUpdates"]
    original = (await client.get(ROOT + f"/projects/{work['id']}")).json()
    assert original["revision"] == work["revision"] and original["document"] == work["document"]

    outfit = await post(
        client,
        "/library/collections",
        {
            "sourceVersionId": updated["id"],
            "requestKey": "new-outfit",
            "mode": "variant",
            "expectedVersionId": updated["id"],
            "variantName": "太空服",
        },
    )
    assert (
        outfit["asset"]["family"] == library["family"]
        and outfit["asset"]["variantId"] != library["variantId"]
    )
    detail = (await client.get(ROOT + f"/library/{outfit['asset']['id']}/detail")).json()
    assert len(detail["variants"]) == 2 and len(detail["versions"]) == 3
    assert (await client.get(ROOT + "/library", params={"category": "characters"})).json()[
        "total"
    ] == 1
    # 新增太空服不是原默认造型的新版本，已有片的更新提示不能串到另一造型。
    original_preview = await post(
        client,
        f"/projects/{work['id']}/library-updates/preview",
        {"assetId": role["id"]},
    )
    assert original_preview["sourceVersionId"] == updated["id"]


async def test_library_concurrent_collection_archive_and_permissions(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    auth = await bootstrap(client)
    account = await app.state.services.identity.authenticate(auth["accessToken"])
    work = await post(client, "/projects", {"title": "素材测试"})
    scene = await post(
        client, "/assets", {"kind": "scene", "name": "外星森林", "project": work["id"]}
    )
    values = {"sourceVersionId": scene["id"], "requestKey": "parallel", "mode": "new"}
    responses = await asyncio.gather(
        *[client.post(ROOT + "/library/collections", json=values) for _ in range(2)]
    )
    assert all(response.status_code == 200 for response in responses), [r.text for r in responses]
    assert responses[0].json() == responses[1].json()
    library = responses[0].json()["asset"]
    assert (await client.get(ROOT + "/library", params={"category": "scenes"})).json()["total"] == 1
    assert (await client.get(ROOT + "/library", params={"category": "props"})).json()["total"] == 0
    assert (await client.get(ROOT + "/library", params={"kinds": "prop,scene"})).json()[
        "total"
    ] == 1
    changed_key = await client.post(
        ROOT + "/library/collections", json={**values, "variantName": "不匹配"}
    )
    assert changed_key.status_code == 409
    archived = await post(
        client,
        f"/library/{library['id']}/archive",
        {"requestKey": "archive", "expectedVersionId": library["id"], "archived": True},
    )
    assert archived["archived"]
    assert (
        await client.get(ROOT + "/library", params={"category": "scenes", "archived": True})
    ).json()["total"] == 1
    assert (await client.get(ROOT + "/library", params={"category": "scenes"})).json()["total"] == 0
    assert (await client.get(ROOT + f"/library/{library['id']}/detail")).json()["asset"]["archived"]
    # 归档只隐藏库条目，旧作品设定及其来源仍然可读取；同一个入口可恢复。
    assert (await client.get(ROOT + f"/library/{scene['id']}/detail")).status_code == 200
    await post(
        client,
        f"/library/{library['id']}/archive",
        {
            "requestKey": "restore",
            "expectedVersionId": library["id"],
            "archived": False,
        },
    )
    effective = replace(
        account,
        permissions=(
            "products.entertainment",
            "studio.assets.read",
            "studio.projects.read",
        ),
    )

    async def acting(_: Request) -> Account:
        return effective

    monkeypatch.setattr(dependencies, "current_account", acting)
    assert (await client.get(ROOT + "/library")).status_code == 200
    assert (await client.post(ROOT + "/library/collections", json=values)).status_code == 403
    effective = replace(account, user_id=uuid4().hex)
    assert (await client.get(ROOT + f"/library/{library['id']}/detail")).status_code == 404
    assert (
        await client.post(ROOT + "/library/collections", json={**values, "requestKey": "outsider"})
    ).status_code == 404
    assert (
        await client.post(
            ROOT + f"/projects/{work['id']}/library-imports",
            json={
                "sourceVersionId": library["id"],
                "requestKey": "outsider-import",
                "expectedRevision": work["revision"],
            },
        )
    ).status_code == 404


async def test_library_edit_request_replay_and_same_variant_cas(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client)
    create = {"kind": "character", "name": "小金毛", "requestKey": "create-golden"}
    responses = await asyncio.gather(
        *[client.post(ROOT + "/assets", json=create) for _ in range(2)]
    )
    assert all(response.status_code == 200 for response in responses)
    original = responses[0].json()
    assert responses[1].json() == original
    change = {
        **create,
        "requestKey": "edit-golden",
        "parent": original["id"],
        "expectedVersionId": original["id"],
        "description": "红项圈",
    }
    changed = await post(client, "/assets", change)
    assert await post(client, "/assets", change) == changed
    stale = await client.post(
        ROOT + "/assets",
        json={**change, "requestKey": "stale", "description": "不能覆盖"},
    )
    assert stale.status_code == 409
    assert (
        await client.post(
            ROOT + "/assets",
            json={**change, "expectedVersionId": None, "requestKey": "no-base"},
        )
    ).status_code == 422
    other_variant = await post(
        client,
        "/library/collections",
        {
            "sourceVersionId": changed["id"],
            "requestKey": "costume",
            "mode": "variant",
            "expectedVersionId": changed["id"],
            "variantName": "宇航服",
        },
    )
    # 最新家族指针已经指向另一造型，编辑原造型仍按该造型自身基线校验。
    edit_original = await post(
        client,
        "/assets",
        {
            **change,
            "parent": changed["id"],
            "expectedVersionId": changed["id"],
            "requestKey": "edit-original-outfit",
            "description": "红项圈加星星",
        },
    )
    assert edit_original["variantId"] == original["variantId"]
    assert edit_original["variantId"] != other_variant["asset"]["variantId"]
    listed = (await client.get(ROOT + "/library", params={"category": "characters"})).json()
    assert listed["total"] == 1 and listed["items"][0]["id"] == edit_original["id"]


async def test_library_voice_preview_is_reusable_and_never_becomes_cover(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    auth = await bootstrap(client)
    account = await app.state.services.identity.authenticate(auth["accessToken"])
    media = app.state.services.media_jobs
    await media.close()
    picture = BytesIO()
    Image.new("RGB", (4, 4), "white").save(picture, format="PNG")
    reference = await app.state.services.files.ingest(
        account, "形象.png", picture.getvalue(), "image/png"
    )
    work = await post(client, "/projects", {"title": "声音来源"})
    role = await post(
        client,
        "/assets",
        {
            "kind": "character",
            "name": "啵啵",
            "voice": "voice-c",
            "fileId": reference["id"],
            "project": work["id"],
        },
    )
    job_id = uuid4().hex
    async with media.database.sessions.begin() as session:
        version = await session.get(EntityVersion, role["id"])
        assert version is not None
        version.voice_parameters = {"previewJob": job_id, "text": "欢迎"}
        session.add(
            MediaJob(
                id=job_id,
                project=work["id"],
                owner=account.user_id,
                request_key="voice-preview",
                subject=role["id"],
                kind="speech",
                revision=work["revision"],
                state="ready",
                payload={"owner": account.user_id, "duration": 1000},
            )
        )
    media.root.mkdir(parents=True, exist_ok=True)
    with wave.open(str(media.root / (job_id + ".wav")), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(bytes(16000))
    collected = await post(
        client,
        "/library/collections",
        {"sourceVersionId": role["id"], "requestKey": "collect-voice"},
    )
    personal = collected["asset"]
    assert personal["fileId"] == reference["id"]
    assert personal["voicePreviewAssetId"] and not personal["voicePreviewJob"]
    preview = f"{ROOT}/assets/{personal['voicePreviewAssetId']}"
    assert (await client.post(preview + "/access")).status_code == 200
    content = await client.get(preview + "/content")
    assert content.status_code == 200 and content.content[:4] == b"RIFF"
    replacement_audio = BytesIO()
    with wave.open(replacement_audio, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(bytes(32000))
    alternate = await app.state.services.files.ingest(
        account, "替换声音.wav", replacement_audio.getvalue(), "audio/wav"
    )
    replaced_media = await post(
        client,
        "/assets",
        {
            "kind": "audio",
            "name": "替换声音",
            "fileId": alternate["id"],
            "parent": personal["voicePreviewAssetId"],
        },
    )
    assert replaced_media["sourceJob"] is None and replaced_media["durationMs"] is None
    target = await post(client, "/projects", {"title": "复用声音"})
    imported = await post(
        client,
        f"/projects/{target['id']}/library-imports",
        {
            "sourceVersionId": personal["id"],
            "expectedRevision": target["revision"],
            "requestKey": "reuse-voice",
        },
    )
    imported_role = next(item for item in imported["assets"] if item["id"] == imported["assetId"])
    assert imported_role["voicePreviewAssetId"] == personal["voicePreviewAssetId"]
    assert imported_role["fileId"] == reference["id"]
    replacement = BytesIO()
    Image.new("RGB", (4, 4), "green").save(replacement, format="PNG")
    green = await app.state.services.files.ingest(
        account, "新造型.png", replacement.getvalue(), "image/png"
    )
    updated = await post(
        client,
        "/assets",
        {
            "kind": "character",
            "name": "啵啵",
            "voice": "voice-c",
            "fileId": green["id"],
            "parent": personal["id"],
            "expectedVersionId": personal["id"],
            "requestKey": "new-picture",
        },
    )
    assert (
        updated["fileId"] == green["id"]
        and updated["voicePreviewAssetId"] == personal["voicePreviewAssetId"]
    )
    changed_voice = await post(
        client,
        "/assets",
        {
            "kind": "character",
            "name": "啵啵",
            "voice": "new-voice",
            "fileId": green["id"],
            "parent": updated["id"],
            "expectedVersionId": updated["id"],
            "requestKey": "new-voice",
        },
    )
    assert changed_voice["fileId"] == green["id"]
    assert changed_voice["voicePreviewAssetId"] is None
