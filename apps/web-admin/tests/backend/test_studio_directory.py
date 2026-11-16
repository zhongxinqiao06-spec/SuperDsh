"""真实数据库验证作品目录、素材复用、任务汇总与权限边界。"""

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
from app.modules.studio.entity.do.models import MediaJob


async def test_directory_scope_versions_and_access(
    platform: tuple[FastAPI, AsyncClient],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, client = platform
    auth = await bootstrap(client)
    account = await app.state.services.identity.authenticate(auth["accessToken"])
    root = "/api/studio"

    async def project(name: str) -> str:
        response = await client.post(root + "/projects", json={"title": name})
        assert response.status_code == 200, response.text
        return str(response.json()["id"])

    first, second = await project("雾港 100%"), await project("眺望")
    role = (
        await client.post(root + "/assets", json={"kind": "character", "name": "夜航员"})
    ).json()["id"]
    address = f"{root}/projects/{first}/assets/{role}/link"
    assert (await client.post(address)).json() == {"revision": 2}
    assert (await client.post(address)).json() == {"revision": 2}
    assert (await client.post(f"{root}/projects/{second}/assets/{role}/link")).json() == {
        "revision": 2
    }
    scene = (
        await client.post(
            root + "/assets", json={"kind": "scene", "name": "灯塔", "project": first}
        )
    ).json()["id"]
    assert (await client.post(f"{root}/projects/{second}/assets/{scene}/link")).status_code == 404

    media = app.state.services.media_jobs
    await media.close()
    async with media.database.sessions.begin() as session:
        session.add_all(
            [
                MediaJob(
                    id="succeeded",
                    project=first,
                    request_key="job-a",
                    subject="shot-a",
                    kind="video",
                    revision=2,
                    state="ready",
                    payload={},
                ),
                MediaJob(
                    id="second-shot",
                    project=first,
                    request_key="job-later",
                    subject="shot-b",
                    kind="video",
                    revision=2,
                    state="ready",
                    payload={},
                ),
                MediaJob(
                    id="failed",
                    project=second,
                    request_key="job-b",
                    subject="line-b",
                    kind="speech",
                    revision=2,
                    state="failed",
                    payload={"text": "我们进港了。", "voice": "private-voice"},
                    error="未找到音色",
                ),
            ]
        )
    saved = await client.put(
        f"{root}/projects/{first}",
        json={
            "revision": 2,
            "document": {
                "assets": [role],
                "shots": [
                    {
                        "id": "shot-a",
                        "action": "驶入港湾",
                        "candidate": "succeeded",
                        "references": [role],
                    },
                    {"id": "shot-b", "action": "靠岸"},
                ],
            },
        },
    )
    assert saved.status_code == 200, saved.text
    matches = await client.get(root + "/projects", params={"page": 1, "search": "%"})
    assert matches.status_code == 200, matches.text
    result = matches.json()
    assert (
        result["total"] == 1
        and result["items"][0]["shots"] == 2
        and result["items"][0]["adopted"] == 1
        and result["items"][0]["coverJobId"] == "succeeded"
    )
    uncovered = (await client.get(root + "/projects", params={"page": 1, "search": "眺望"})).json()
    assert uncovered["items"][0]["coverJobId"] is None
    assert "document" not in result["items"][0]
    # 同一作品的多个已采用结果以当前剪辑顺序决定封面；另一个作品的地址不可复用授权。
    changed = await client.put(
        f"{root}/projects/{first}",
        json={
            "revision": saved.json()["revision"],
            "document": {
                "assets": [role],
                "shots": [
                    {"id": "shot-b", "action": "靠岸", "candidate": "second-shot"},
                    {
                        "id": "shot-a",
                        "action": "驶入港湾",
                        "candidate": "succeeded",
                        "references": [role],
                    },
                ],
            },
        },
    )
    assert changed.status_code == 200, changed.text
    reordered = (await client.get(root + "/projects", params={"page": 1, "search": "%"})).json()
    assert reordered["items"][0]["coverJobId"] == "second-shot"
    usage_path = f"{root}/library/{role}/usage"
    uses = (await client.get(usage_path)).json()
    assert uses["total"] == 2
    assert {w["project"]: w["shots"] for w in uses["items"]} == {
        first: [{"id": "shot-a", "number": 2, "adopted": False}],
        second: [],
    }
    assert (await client.get(usage_path, params={"project": second})).json()["total"] == 1
    media.root.mkdir(parents=True, exist_ok=True)
    (media.root / "second-shot.mp4").write_bytes(b"synthetic-media-range")
    cover_path = f"{root}/projects/{first}/media/second-shot"
    assert (await client.post(cover_path + "/access")).status_code == 200
    clip = await client.get(cover_path, headers={"Range": "bytes=0-3"})
    assert clip.status_code == 206 and clip.content == b"synt"
    assert (
        await client.post(f"{root}/projects/{second}/media/second-shot/access")
    ).status_code == 404
    assert (await client.get(root + "/projects", params={"page": 2, "pageSize": 1})).json()[
        "total"
    ] == 2
    personal = (await client.get(root + "/library")).json()
    assert (
        personal["total"] == 1
        and personal["items"][0]["id"] == role
        and personal["items"][0]["workId"] is None
    )
    works = (
        await client.get(root + "/library", params={"scope": "project", "kind": "character"})
    ).json()
    assert {(item["workId"], item["parent"]) for item in works["items"]} == {
        (first, role),
        (second, role),
    }
    owned = (
        await client.get(
            root + "/library",
            params={"scope": "project", "kind": "scene", "search": "雾港"},
        )
    ).json()
    assert owned["total"] == 1 and owned["items"][0]["id"] == scene
    # 个人文件预览使用仅限一个文件的短效授权，可直接响应播放器的 Range 请求。
    png = BytesIO()
    Image.new("RGB", (2, 2)).save(png, format="PNG")
    reference = await app.state.services.files.ingest(
        account, "海港.png", png.getvalue(), "image/png"
    )
    image = await client.post(
        root + "/assets",
        json={"kind": "image", "name": "海港参考", "fileId": reference["id"]},
    )
    personal_file = f"{root}/assets/{image.json()['id']}"
    assert (await client.get(personal_file + "/content")).status_code == 401
    assert (await client.post(personal_file + "/access")).status_code == 200
    segment = await client.get(personal_file + "/content", headers={"Range": "bytes=0-2"})
    assert segment.status_code == 206 and segment.content == png.getvalue()[:3]
    jobs = (
        await client.get(
            root + "/jobs",
            params={"state": "failed", "kind": "speech", "search": "眺望"},
        )
    ).json()
    assert jobs["total"] == 1 and jobs["items"][0]["project"] == second
    assert jobs["items"][0]["summary"] == "我们进港了。"
    assert jobs["items"][0]["error"] == "未找到音色" and "payload" not in jobs["items"][0]
    assert (await client.get(root + "/jobs", params={"pageSize": 0})).status_code == 422

    # 重试沿用原供应商回执和任务 ID；未收到回执的未知提交绝不能重新计费。
    async with media.database.sessions.begin() as session:
        session.add_all(
            [
                MediaJob(
                    id=key,
                    project=first,
                    request_key=key,
                    subject="shot-a",
                    kind="video",
                    revision=2,
                    state=state,
                    provider_id=receipt,
                    payload=payload,
                )
                for key, state, receipt, payload in [
                    (
                        "recoverable",
                        "failed",
                        "provider-task",
                        {"recoveryState": "polling", "failures": 5},
                    ),
                    ("query-receipt", "unknown", "provider-task-2", {}),
                    ("missing-receipt", "unknown", None, {}),
                ]
            ]
        )

    def recovery(key: str, project: str = first) -> str:
        return f"{root}/projects/{project}/jobs/{key}/recover"

    assert (await client.post(recovery("recoverable", second))).status_code == 404
    assert (await client.post(recovery("missing-receipt"))).status_code == 409
    for key in ("recoverable", "query-receipt"):
        recovered = await client.post(recovery(key))
        assert recovered.status_code == 200 and recovered.json()["state"] == "polling"
        assert recovered.json()["id"] == key
        assert (await client.post(recovery(key))).status_code == 409

    async def acting(_: Request) -> Account:
        return effective

    effective = replace(account, permissions=("products.entertainment", "models.use"))
    monkeypatch.setattr(dependencies, "current_account", acting)
    models = await client.get(root + "/catalog")
    assert models.status_code == 200 and models.json()["agents"] == []
    assert (await client.post(f"{root}/assets/{role}/access")).status_code == 403

    # 即使仍有娱乐权限，也不能列出其他账号的作品、任务或不可变素材版本。
    effective = replace(
        effective,
        user_id=uuid4().hex,
        permissions=(
            *effective.permissions,
            "studio.projects.read",
            "studio.projects.write",
            "studio.assets.read",
        ),
    )
    assert (await client.get(usage_path)).status_code == 404
    assert (await client.post(cover_path + "/access")).status_code == 404
    for path in ("/projects?page=1", "/library", "/library?scope=project", "/jobs"):
        assert (await client.get(root + path)).json() == {"items": [], "total": 0}
    assert (await client.post(address)).status_code == 404
    effective = replace(account, permissions=("products.office",))
    assert (await client.post(recovery("recoverable"))).status_code == 403
    assert (await client.post(cover_path + "/access")).status_code == 403
    for path in ("/projects?page=1", "/library", "/jobs"):
        assert (await client.get(root + path)).status_code == 403
