"""独立收尾审查新增的旧候选编号、撤权预检和分集素材锁边界。"""

from dataclasses import replace

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from test_studio_quick import create_quick, make_plan
from test_studio_quick import platform_settings as platform_settings

from app.infrastructure.errors import DomainError
from app.modules.studio.entity.bo.production import input_hash
from app.modules.studio.entity.do.models import MediaJob
from app.modules.studio.entity.vo.quick_vo import QuickIntent


async def test_quick_legacy_sequence_hash_and_revoked_reference_access(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    auth = await bootstrap(client)
    media = app.state.services.media_jobs
    await media.close()
    uri, saved = await create_quick(client)
    async with media.database.sessions.begin() as session:
        for identity in ("legacy-a", "legacy-b"):
            session.add(
                MediaJob(
                    id=identity,
                    project=saved["id"],
                    request_key=identity,
                    subject="quick_" + saved["id"],
                    kind="video",
                    revision=saved["revision"],
                    state="failed",
                    payload={},
                )
            )
    plan = await make_plan(client, uri, saved["revision"], "after-legacy")
    result = await client.post(
        uri + "/quick/generation-plans/" + plan["id"] + "/confirm",
        json={
            "revision": plan["revision"],
            "requestKey": "confirm-after-legacy",
            "planHash": plan["planHash"],
        },
    )
    assert result.status_code == 200, result.text
    identity = result.json()["jobs"][0]["id"]
    async with media.database.sessions.begin() as session:
        job = await session.get(MediaJob, identity)
        assert job is not None
        assert job.payload["quickSequence"] == 3
        assert input_hash("video", job.payload) == job.payload["inputHash"]
        without_sequence = {
            key: value for key, value in job.payload.items() if key != "quickSequence"
        }
        assert input_hash("video", without_sequence) == job.payload["inputHash"]
        job.state = "ready"
    state = (await client.get(uri + "/quick")).json()
    assert [job["id"] for job in state["jobs"]] == [identity, "legacy-a", "legacy-b"]
    assert [job.get("candidateNumber") for job in state["jobs"]] == [3, None, None]
    plan = await make_plan(client, uri, saved["revision"], "same-input-after-sequence")
    assert plan["items"][0]["status"] == "ready" and plan["issues"]
    asset = (
        await client.post("/api/studio/assets", json={"kind": "character", "name": "已有角色"})
    ).json()
    edited = await client.put(
        uri + "/quick",
        json={
            "revision": saved["revision"],
            "requestKey": "save-reference-before-revoke",
            "title": "引用已有角色",
            "draft": {
                **saved["draft"],
                "inputMode": "reference",
                "configurationId": "reference",
                "references": [asset["id"]],
            },
        },
    )
    assert edited.status_code == 200, edited.text
    account = await app.state.services.identity.authenticate(auth["accessToken"])
    reduced = replace(
        account, permissions=tuple(p for p in account.permissions if p != "studio.assets.read")
    )
    with pytest.raises(DomainError, match="studio.assets.read") as denied:
        await media.quick.generation.inspect(
            reduced,
            saved["id"],
            QuickIntent(revision=edited.json()["revision"], requestKey="revoked-precheck"),
        )
    assert denied.value.status == 403


async def test_locked_episode_rejects_direct_asset_create_and_update(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client)
    series = (
        await client.post(
            "/api/studio/series",
            json={
                "title": "素材锁",
                "requestKey": "asset-lock-series",
                "plannedEpisodes": 1,
                "createEpisodeDrafts": True,
            },
        )
    ).json()
    episode = series["episodes"][0]
    body = {"project": episode["projectId"], "kind": "character", "name": "锁前角色"}
    before = await client.post("/api/studio/assets", json=body)
    assert before.status_code == 200, before.text
    asset = before.json()
    locked = await client.post(
        f"/api/studio/series/{series['id']}/episodes/{episode['id']}/lock",
        json={"revision": series["revision"], "requestKey": "lock-before-asset", "locked": True},
    )
    assert locked.status_code == 200, locked.text
    for attempt in (
        {**body, "name": "新增应拒绝"},
        {**body, "name": "修改应拒绝", "parent": asset["id"]},
    ):
        denied = await client.post("/api/studio/assets", json=attempt)
        assert denied.status_code == 409 and "锁定" in denied.text
    opened = (await client.get(f"/api/studio/projects/{episode['projectId']}")).json()
    assert [item["id"] for item in opened["assets"]] == [asset["id"]]
