"""真实迁移和接口上的制作闭环；供应商使用受控响应，不发送真实付费请求。"""

import asyncio
import base64
import io
import json
from pathlib import Path

import httpx
import pytest
from conftest import bootstrap_studio, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from test_studio_preparation import create, preparation_configuration

from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.studio.entity.do.models import MediaJob


@pytest.fixture
def platform_settings(tmp_path: Path) -> dict[str, object]:
    settings = preparation_configuration(tmp_path)
    path = Path(str(settings["model_defaults_file"]))
    data = json.loads(path.read_text())
    data["configurations"].append(
        {
            "id": "video",
            "name": "受控视频",
            "connectionId": "speech",
            "capability": "video.generate",
            "modelId": "synthetic-video",
            "enabled": True,
            "roleIds": [],
            "parameters": {"inputMode": "text"},
        }
    )
    data["defaults"]["video.generate"] = "video"
    path.write_text(json.dumps(data), encoding="utf-8")
    return settings


async def confirmed(client: AsyncClient, uri: str, body: dict) -> tuple[dict, list[dict]]:
    response = await client.post(uri + "/generation-plans", json=body)
    assert response.status_code == 200, response.text
    plan = response.json()
    confirmation = {
        "revision": body["revision"],
        "requestKey": "confirm-" + body["requestKey"],
        "planHash": plan["planHash"],
    }
    response = await client.post(
        uri + "/generation-plans/" + plan["id"] + "/confirm", json=confirmation
    )
    assert response.status_code == 200, response.text
    # 确认重试使用同一计划，不因任务已在队列中重复创建。
    repeated = await client.post(
        uri + "/generation-plans/" + plan["id"] + "/confirm", json=confirmation
    )
    assert repeated.json() == response.json()
    return plan, response.json()["jobs"]


async def test_personal_generation_version_and_isolation(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap_studio(client)
    media = app.state.services.media_jobs
    await media.close()
    asset = (
        await client.post(
            "/api/studio/assets",
            json={"kind": "character", "name": "独立角色", "description": "蓝外套"},
        )
    ).json()
    uri = "/api/studio/entities/" + asset["family"]
    before_projects = (await client.get("/api/studio/projects")).json()
    picture = io.BytesIO()
    Image.new("RGB", (32, 32), "blue").save(picture, "PNG")
    calls = []

    def provider(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(
            200, json={"data": [{"b64_json": base64.b64encode(picture.getvalue()).decode()}]}
        )

    media.models.transport = ProviderTransport(transport=httpx.MockTransport(provider))
    state = (await client.get(uri + "/production")).json()
    body = {"revision": state["revision"], "requestKey": "personal-picture", "kind": "reference"}
    plan, jobs = await confirmed(client, uri, body)
    assert not calls and len(jobs) == 1
    assert (await client.get("/api/studio/projects")).json() == before_projects
    job_id = jobs[0]["id"]
    for _ in range(2):
        async with media.database.sessions() as session:
            row = await session.get(MediaJob, job_id)
            assert row is not None and row.project is None and row.owner
        await media.process(row)
    assert len(calls) == 1
    ready = (await client.get(uri + "/production")).json()
    assert ready["jobs"][0]["state"] == "ready" and ready["asset"]["id"] == asset["id"]
    assert (await client.post(f"/api/studio/personal-media/{job_id}/access")).status_code == 200
    body = {"revision": ready["revision"], "requestKey": "adopt-personal", "job": job_id}
    response = await client.post(uri + "/adopt", json=body)
    assert response.status_code == 200, response.text
    assert (await client.post(uri + "/adopt", json=body)).json() == response.json()
    adopted = (await client.get(uri + "/production")).json()
    assert adopted["revision"] == ready["revision"] + 1
    assert adopted["asset"]["id"] != asset["id"] and adopted["asset"]["fileId"]
    # 另一账号不能读个人候选、采用或查询回执。
    other = await client.post(
        "/api/admin/users",
        json={
            "username": "othercreator",
            "password": "Another123!",
            "displayName": "另一位创作者",
            "roles": ["entertainment_creator"],
        },
    )
    assert other.status_code == 201, other.text
    login = await complete_initial_login(client, "othercreator", "Another123!")
    headers = {"Authorization": "Bearer " + str(login["accessToken"])}
    assert (await client.get(uri + "/production", headers=headers)).status_code == 404
    assert (
        await client.post(f"/api/studio/personal-media/{job_id}/access", headers=headers)
    ).status_code == 404
    assert (await client.post(uri + "/adopt", headers=headers, json=body)).status_code == 404
    assert (
        await client.get(f"/api/studio/jobs/{job_id}/actions", headers=headers)
    ).status_code == 404


async def test_preflight_ranges_cancel_and_receipt(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    await bootstrap_studio(client)
    media = app.state.services.media_jobs
    await media.close()
    uri, project = await create(client)
    # 缺失音色必须在预检暴露，而不是提交后才失败。
    body = {"revision": project["revision"], "requestKey": "blocked", "mode": "missing"}
    response = await client.post(uri + "/generation-plans", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["issues"] and not (await client.get(uri)).json()["jobs"]
    body.update(requestKey="single", mode="selected", shots=["station"])
    plan, jobs = await confirmed(client, uri, body)
    video = jobs[0]
    cancel = {"revision": video["revision"], "requestKey": "cancel", "action": "cancel"}
    response = await client.post("/api/studio/jobs/" + video["id"] + "/actions", json=cancel)
    assert response.status_code == 200 and response.json()["state"] == "cancelled", response.text
    async with media.database.sessions() as session:
        row = await session.get(MediaJob, video["id"])
    assert row is not None and not await media.claim(row)
    assert (
        await client.post("/api/studio/jobs/" + video["id"] + "/actions", json=cancel)
    ).json() == response.json()
    # 相同输入的现有候选被跳过，失败项只选真实生成失败，不重发可恢复下载。
    async with media.database.sessions.begin() as session:
        row = await session.get(MediaJob, video["id"])
        row.state, row.cancel_requested = "ready", False
    body.update(requestKey="missing-ready", mode="missing", shots=[])
    inspected = (await client.post(uri + "/generation-plans", json=body)).json()
    item = next(i for i in inspected["items"] if i["kind"] == "video")
    assert item["status"] == "ready" and not item["selected"]
    async with media.database.sessions.begin() as session:
        row = await session.get(MediaJob, video["id"])
        row.state = "failed"
    body.update(requestKey="failed", mode="failed")
    failed = (await client.post(uri + "/generation-plans", json=body)).json()
    assert [i["kind"] for i in failed["items"] if i["selected"]] == ["video"]
    async with media.database.sessions.begin() as session:
        row = await session.get(MediaJob, video["id"])
        row.state = "unknown"
    body.update(requestKey="unknown", mode="missing")
    unknown = (await client.post(uri + "/generation-plans", json=body)).json()
    assert not next(i for i in unknown["items"] if i["kind"] == "video")["selected"]
    action_uri = "/api/studio/jobs/" + video["id"] + "/actions"
    action = {
        "revision": video["revision"],
        "requestKey": "foreign-receipt",
        "action": "receipt",
        "providerTask": "another-users-task",
    }
    assert (await client.post(action_uri, json=action)).status_code == 422
    assert (await client.post(action_uri, json={**action, "providerTask": ""})).status_code == 409
    result = await client.post(
        action_uri,
        json={
            **action,
            "requestKey": "manual",
            "action": "unaccepted",
            "providerTask": "",
            "reason": "供应商控制台未查询到，人工记录",
            "acknowledged": True,
        },
    )
    assert result.status_code == 200 and result.json()["state"] == "unaccepted", result.text
    assert len((await client.get(action_uri)).json()) == 2
    # 人工另行生成保留原审计，但旧未知记录不能永久堵住以后补缺失。
    body.update(
        requestKey="replacement",
        mode="selected",
        shots=["station"],
        allowDuplicate=True,
        reason="已核对仍决定重做",
    )
    _, replacement = await confirmed(client, uri, body)
    async with media.database.sessions.begin() as session:
        old = await session.get(MediaJob, video["id"])
        assert old is not None and old.payload.get("replacementPlan")
        new = await session.get(MediaJob, replacement[0]["id"])
        assert new is not None
        new.state = "ready"
    body.update(requestKey="after-replacement", mode="missing", allowDuplicate=False, reason="")
    result = (await client.post(uri + "/generation-plans", json=body)).json()
    assert next(i for i in result["items"] if i["kind"] == "video")["status"] == "ready"


async def test_durable_receipt_recovers_without_resubmitting(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap_studio(client)
    media = app.state.services.media_jobs
    await media.close()
    uri, project = await create(client)
    _, jobs = await confirmed(
        client,
        uri,
        {
            "revision": project["revision"],
            "requestKey": "receipt",
            "mode": "selected",
            "shots": ["station"],
        },
    )
    async with media.database.sessions.begin() as session:
        job = await session.get(MediaJob, jobs[0]["id"])
        assert job is not None
        job.state = "unknown"
        media.save_submission(job, task="durable-task")
    calls = []

    def provider(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        assert request.url.path.endswith("/durable-task")
        return httpx.Response(200, json={"output": {"task_status": "RUNNING"}})

    media.models.transport = ProviderTransport(transport=httpx.MockTransport(provider))
    response = await client.post(
        "/api/studio/jobs/" + jobs[0]["id"] + "/actions",
        json={"revision": project["revision"], "requestKey": "reattach", "action": "receipt"},
    )
    assert response.status_code == 200 and response.json()["state"] == "polling", response.text
    assert calls == ["GET"]
    async with media.database.sessions() as session:
        restored = await session.get(MediaJob, jobs[0]["id"])
        assert restored is not None and restored.provider_id == "durable-task"


def test_dependency_state_keeps_ready_candidates_and_failed_redo() -> None:
    from types import SimpleNamespace

    from app.modules.studio.entity.bo.production import candidate_state

    payload = {"prompt": "雨夜", "seconds": 5, "binding": {"configurationId": "model"}}
    ready = SimpleNamespace(id="old", subject="shot", kind="video", state="ready", payload=payload)
    failed = SimpleNamespace(
        id="new", subject="shot", kind="video", state="failed", payload=payload
    )
    assert candidate_state("video", "shot", payload, [failed, ready])["status"] == "failed"
    failed.payload = {**payload, "recoveryState": "polling"}
    assert candidate_state("video", "shot", payload, [failed, ready])["status"] == "recoverable"
    assert (
        candidate_state("video", "shot", {**payload, "prompt": "雪夜"}, [ready])["status"]
        == "outdated"
    )


async def test_concurrent_confirm_late_receipt_and_stale_revision(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap_studio(client)
    media = app.state.services.media_jobs
    await media.close()
    uri, project = await create(client)
    body = {
        "revision": project["revision"],
        "requestKey": "parallel",
        "mode": "selected",
        "shots": ["station"],
    }
    response = await client.post(uri + "/generation-plans", json=body)
    assert response.status_code == 200, response.text
    plan = response.json()
    confirmation = {
        "revision": body["revision"],
        "requestKey": "confirm",
        "planHash": plan["planHash"],
    }
    results = await asyncio.gather(
        *(
            client.post(uri + "/generation-plans/" + plan["id"] + "/confirm", json=confirmation)
            for _ in range(2)
        )
    )
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    assert results[0].json() == results[1].json()
    video = results[0].json()["jobs"][0]
    async with media.database.sessions() as session:
        row = await session.get(MediaJob, video["id"])
    assert row and await media.claim(row)
    action = {"revision": video["revision"], "requestKey": "late-cancel", "action": "cancel"}
    assert (await client.post("/api/studio/jobs/" + video["id"] + "/actions", json=action)).json()[
        "state"
    ] == "paused"
    await media.mark(row, "polling", provider_id="same-task")
    async with media.database.sessions() as session:
        row = await session.get(MediaJob, video["id"])
        assert row.state == "paused" and row.provider_id == "same-task"
    body.update(requestKey="old-version", allowDuplicate=True, reason="explicit", mode="selected")
    plan = (await client.post(uri + "/generation-plans", json=body)).json()
    assert (
        await client.put(
            uri,
            json={
                "revision": project["revision"],
                "document": {**project["document"], "script": "新内容"},
            },
        )
    ).status_code == 200
    response = await client.post(
        uri + "/generation-plans/" + plan["id"] + "/confirm",
        json={**confirmation, "planHash": plan["planHash"]},
    )
    assert response.status_code == 409
