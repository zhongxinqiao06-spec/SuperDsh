"""快速版真实迁移与 HTTP 闭环，供应商为受控响应，绝不读取真实密钥。"""

import asyncio
import io
import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from conftest import (
    bootstrap,
    bootstrap_studio,
    complete_initial_login,
    grant_studio_points,
    upgrade_database,
)
from fastapi import FastAPI, Request
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.api import dependencies
from app.infrastructure.configuration import Settings
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.do.models import UserRow
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.studio.entity.do.models import MediaJob


@pytest.fixture
def platform_settings(tmp_path: Path) -> dict[str, object]:
    config = tmp_path / "quick-models.json"
    config.write_text(
        json.dumps(
            {
                "connections": [
                    {
                        "id": "fixture",
                        "name": "受控百炼",
                        "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
                        "adapter": "openai-completions",
                        "enabled": True,
                        "apiKey": "synthetic",
                    }
                ],
                "configurations": [
                    {
                        "id": mode,
                        "capability": "video.generate",
                        "connectionId": "fixture",
                        "name": mode,
                        "modelId": "synthetic-" + mode,
                        "enabled": True,
                        "roleIds": [],
                        "parameters": {"inputMode": mode},
                    }
                    for mode in ["text", "reference"]
                ],
                "defaults": {"video.generate": "text"},
            }
        ),
        encoding="utf-8",
    )
    return {"model_defaults_file": config}


async def create_quick(client: AsyncClient, key: str = "new-quick") -> tuple[str, dict]:
    created = await client.post(
        "/api/studio/projects",
        json={"title": "快速登月", "creationMode": "quick", "requestKey": key},
    )
    assert created.status_code == 200, created.text
    uri = "/api/studio/projects/" + created.json()["id"]
    state = (await client.get(uri + "/quick")).json()
    body = {
        "revision": state["revision"],
        "requestKey": "save-draft",
        "title": "快速登月",
        "draft": {
            **state["draft"],
            "prompt": "两只小狗踏上月球",
            "configurationId": "text",
        },
    }
    saved = await client.put(uri + "/quick", json=body)
    assert saved.status_code == 200, saved.text
    return uri, saved.json()


async def make_plan(client: AsyncClient, uri: str, revision: int, key: str) -> dict:
    response = await client.post(
        uri + "/quick/generation-plans", json={"revision": revision, "requestKey": key}
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("role", ["admin", "office_admin", "entertainment_admin"])
async def test_admin_with_empty_wallet_generates_without_credit(
    platform: tuple[FastAPI, AsyncClient], role: str
) -> None:
    app, client = platform
    admin = await bootstrap(client)
    # 办公管理员仍需独立的娱乐产品资格，额度权益本身不授予跨产品访问权。
    if role != "admin":
        username, password = "studio-admin", "Synthetic-role-fixture!"
        roles = [role, "entertainment_creator"] if role == "office_admin" else [role]
        created = await client.post(
            "/api/admin/users",
            json={
                "username": username,
                "displayName": "合成管理员",
                "roles": roles,
                "password": password,
            },
        )
        assert created.status_code == 201, created.text
        login = await complete_initial_login(client, username, password)
        client.headers["Authorization"] = "Bearer " + str(login["accessToken"])
    await app.state.services.media_jobs.close()
    balance = (await client.get("/api/me/billing")).json()
    assert balance["unlimited"] and balance["availablePoints"] == 0
    uri, saved = await create_quick(client)
    plan = await make_plan(client, uri, saved["revision"], "admin-free")
    quote = plan["usageQuote"]
    assert quote["unlimited"] and quote["totalPoints"] == 100
    body = {"revision": plan["revision"], "planHash": plan["planHash"], "requestKey": "admin-job"}
    endpoint = uri + "/quick/generation-plans/" + plan["id"] + "/confirm"
    reply = await client.post(endpoint, json=body)
    assert reply.is_success, reply.text
    assert reply.json()["jobs"][0]["quotedPoints"] == 0
    assert (await client.post(endpoint, json=body)).json() == reply.json()
    assert (await client.get("/api/me/billing/entries")).json()["items"] == []
    if role == "office_admin":
        # 已有免扣报价不能带到降级后的普通账号继续免费提交。
        other, draft = await create_quick(client, "second-admin-work")
        pending = await make_plan(client, other, draft["revision"], "before-demotion")
        endpoint = other + "/quick/generation-plans/" + pending["id"] + "/confirm"
        body = {
            "revision": pending["revision"],
            "planHash": pending["planHash"],
            "requestKey": "after-demotion",
        }
        changed = await client.patch(
            "/api/admin/users/" + str(login["userId"]),
            headers={"Authorization": "Bearer " + str(admin["accessToken"])},
            json={"roles": ["entertainment_creator"]},
        )
        assert changed.is_success, changed.text
        fresh = await client.post(
            "/api/auth/login", json={"identifier": username, "password": password}
        )
        client.headers["Authorization"] = "Bearer " + fresh.json()["accessToken"]
        assert (await client.post(endpoint, json=body)).status_code == 409
        assert not (await client.get("/api/me/billing")).json()["unlimited"]


async def metered_creator(client: AsyncClient) -> tuple[str, str]:
    """用真实创作者身份验证余额不足；只有运营建号及赠点调用使用管理员令牌。"""
    admin = await bootstrap(client)
    admin_token = "Bearer " + str(admin["accessToken"])
    password = "Synthetic-credit-fixture!"
    created = await client.post(
        "/api/admin/users",
        json={
            "username": "metered-creator",
            "displayName": "普通创作者",
            "password": password,
            "roles": ["entertainment_creator"],
        },
    )
    assert created.status_code == 201, created.text
    owner = created.json()["userId"]
    await grant_studio_points(client, owner, 40)
    actor = await complete_initial_login(client, "metered-creator", password)
    client.headers["Authorization"] = "Bearer " + str(actor["accessToken"])
    return owner, admin_token


async def test_generation_wallet_blocks_before_enqueue_and_serializes_concurrent_projects(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    owner, admin_token = await metered_creator(client)
    media = app.state.services.media_jobs
    await media.close()
    plans = []
    for index in range(3):
        uri, saved = await create_quick(client, f"budget-{index}")
        plan = await make_plan(client, uri, saved["revision"], f"price-{index}")
        assert plan["usageQuote"]["totalPoints"] == 100
        plans.append((uri, plan))

    async def confirm(index: int) -> httpx.Response:
        uri, plan = plans[index]
        return await client.post(
            uri + "/quick/generation-plans/" + plan["id"] + "/confirm",
            json={
                "revision": plan["revision"],
                "planHash": plan["planHash"],
                "requestKey": f"charge-{index}",
            },
        )

    async def balance() -> tuple[int, int]:
        data = (await client.get("/api/me/billing")).json()
        return data["availablePoints"], data["heldPoints"]

    declined = await confirm(0)
    assert declined.status_code == 402
    assert declined.json()["context"] == {"availablePoints": 40, "requiredPoints": 100}
    assert (await client.get(plans[0][0] + "/quick")).json()["jobs"] == []
    quote_id = plans[0][1]["usageQuote"]["id"]
    assert (await client.get("/api/billing/usage-quotes/" + quote_id)).json()["lockedAt"] is None
    assert await balance() == (40, 0)
    member_token = client.headers["Authorization"]
    client.headers["Authorization"] = admin_token
    await grant_studio_points(client, owner, 160)
    client.headers["Authorization"] = member_token
    results = await asyncio.gather(*(confirm(i) for i in range(3)))
    assert sorted(r.status_code for r in results) == [200, 200, 402]
    assert await balance() == (0, 200)
    first, second = [i for i, r in enumerate(results) if r.is_success]
    assert (await confirm(first)).json() == results[first].json()
    for i, state in [(first, "ready"), (second, "cancelled")]:
        job_id = results[i].json()["jobs"][0]["id"]
        async with media.database.sessions() as db:
            job = await db.get(MediaJob, job_id)
            assert job is not None
        await media.mark(job, state)
        await media.mark(job, state)
    assert await balance() == (100, 0)
    entries = (await client.get("/api/me/billing/entries")).json()["items"]
    assert sum(e["heldDelta"] for e in entries if e["kind"] == "usage_charge") == -100
    assert sum(e["availableDelta"] for e in entries if e["kind"] == "usage_release") == 100


async def test_card_grants_and_wallet_first_generation(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """两卡有效期均早于普通额度，验证跨卡、原卡释放和余额不足回滚。"""
    from uuid import uuid4

    app, client = platform
    owner, admin_token = await metered_creator(client)
    media = app.state.services.media_jobs
    await media.close()
    values = (await client.get("/api/billing/catalog")).json()["cardDenominations"]
    assert values == [100, 200, 500, 1000, 2000]
    for points, days in [(99, 1), (100, 1), (200, 3)]:
        request = dict(
            userId=owner,
            businessKey=str(uuid4()),
            action="card",
            reason="隔离测试",
            points=points,
            validDays=days,
        )
        preview = await client.post(
            "/api/admin/billing/operation-previews",
            json=request,
            headers={"Authorization": admin_token},
        )
        if points == 99:
            assert preview.status_code == 422
            continue
        assert preview.is_success, preview.text
        confirm = dict(previewId=preview.json()["id"])
        replies = await asyncio.gather(
            *(
                client.post(
                    "/api/admin/billing/adjustments",
                    json=confirm,
                    headers={"Authorization": admin_token},
                )
                for _ in range(2)
            )
        )
        assert all(r.is_success for r in replies) and replies[0].json() == replies[1].json()

    async def cards() -> dict[int, dict]:
        rows = (await client.get("/api/me/billing/cards")).json()["items"]
        assert len(rows) == 2
        return {r["granted"]: r for r in rows}

    assert (await client.get("/api/me/billing/cards?pageSize=1")).json()["hasMore"]
    wallet = (await client.get("/api/me/billing")).json()
    assert (wallet["availablePoints"], wallet["cardPoints"]) == (340, 300)
    for i in range(5):
        uri, saved = await create_quick(client, f"card-{i}")
        plan = await make_plan(client, uri, saved["revision"], f"quote-card-{i}")
        response = await client.post(
            uri + "/quick/generation-plans/" + plan["id"] + "/confirm",
            json={
                "revision": plan["revision"],
                "requestKey": f"card-job-{i}",
                "planHash": plan["planHash"],
            },
        )
        if i == 4:
            assert response.status_code == 402
            assert response.json()["context"]["availablePoints"] == 40
            assert (await client.get(uri + "/quick")).json()["jobs"] == []
            break
        assert response.is_success, response.text
        async with media.database.sessions() as db:
            job = await db.get(MediaJob, response.json()["jobs"][0]["id"])
            assert job is not None
        if i == 0:
            inventory = await cards()
            assert (inventory[100]["held"], inventory[200]["held"]) == (60, 0)
            await media.mark(job, "cancelled")
            inventory = await cards()
            assert (inventory[100]["availablePoints"], inventory[100]["usedPoints"]) == (100, 0)
            continue
        await media.mark(job, "ready")
        await media.mark(job, "ready")
    inventory = await cards()
    assert inventory[100]["status"] == "spent" and inventory[200]["usedPoints"] == 160
    async with media.database.sessions.begin() as db:
        await db.execute(
            text("UPDATE billing_credit_lots SET expires_at=now() WHERE id=:id"),
            {"id": inventory[200]["id"]},
        )
    expired = (await cards())[200]
    assert (expired["availablePoints"], expired["status"], expired["usedPoints"]) == (
        0,
        "expired",
        160,
    )
    assert (await client.get("/api/me/billing")).json()["availablePoints"] == 0


async def test_quick_quote_expiry_and_price_lock(platform: tuple[FastAPI, AsyncClient]) -> None:
    from datetime import UTC, datetime, timedelta
    from uuid import uuid4

    from app.modules.billing.entity.do.pricing_do import UsageQuote

    app, client = platform
    await bootstrap_studio(client)
    media = app.state.services.media_jobs
    await media.close()
    uri, saved = await create_quick(client)
    initial = await make_plan(client, uri, saved["revision"], "first-quote")
    assert initial["usageQuote"]["totalPoints"] == 100
    saved = (
        await client.put(
            uri + "/quick",
            json={
                "revision": saved["revision"],
                "title": "合成八秒",
                "requestKey": "eight",
                "draft": {**saved["draft"], "durationSeconds": 8},
            },
        )
    ).json()
    expired = await make_plan(client, uri, saved["revision"], "expired")
    async with media.database.sessions.begin() as db:
        row = await db.get(UsageQuote, expired["usageQuote"]["id"])
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)

    async def confirm(plan: dict) -> httpx.Response:
        return await client.post(
            uri + "/quick/generation-plans/" + plan["id"] + "/confirm",
            json={
                "revision": plan["revision"],
                "planHash": plan["planHash"],
                "requestKey": "confirmed",
            },
        )

    assert (await confirm(expired)).status_code == 409
    plan = await make_plan(client, uri, saved["revision"], "renewed")
    assert plan["usageQuote"]["totalPoints"] == 160
    terms = dict(
        product="entertainment",
        capability="video.generate",
        spec="720P",
        model="text",
        modelRevision=0,
        unit="second",
        unitSize=1,
        unitPoints=30,
        payer="platform",
    )
    draft = (
        await client.post(
            "/api/admin/billing/rate-versions",
            json=dict(terms=terms, expectedRevision=0, reason="合成调价", businessKey=str(uuid4())),
        )
    ).json()
    assert (
        await client.post(
            "/api/admin/billing/rate-versions/" + draft["id"] + "/publish", json={"revision": 1}
        )
    ).is_success
    newer = await make_plan(client, uri, saved["revision"], "new-price")
    assert newer["usageQuote"]["totalPoints"] == 240
    response = await confirm(plan)
    assert response.is_success, response.text
    result = response.json()
    assert result["usageQuote"]["lockedAt"] and result["usageQuote"]["unlimited"]
    assert result["usageQuote"]["totalPoints"] == 160 and result["jobs"][0]["quotedPoints"] == 0
    changed = (
        await client.post(
            "/api/admin/billing/rate-versions",
            json=dict(
                terms=dict(terms, unitPoints=35),
                expectedRevision=1,
                reason="确认后再次调价",
                businessKey=str(uuid4()),
            ),
        )
    ).json()
    assert (
        await client.post(
            "/api/admin/billing/rate-versions/" + changed["id"] + "/publish", json={"revision": 2}
        )
    ).is_success
    item = {k: v for k, v in terms.items() if k not in {"unit", "unitSize", "unitPoints"}}
    fresh = await client.post(
        "/api/billing/usage-quotes",
        json=dict(businessKey=str(uuid4()), source="after-confirm", items=[dict(item, quantity=8)]),
    )
    assert fresh.json()["totalPoints"] == 280
    assert (await confirm(plan)).json() == result
    assert (
        await client.get("/api/billing/usage-quotes/" + plan["usageQuote"]["id"])
    ).json() == result["usageQuote"]


async def test_quick_candidate_numbers_survive_status_updates(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """迟到结果或核对更新不能把旧候选变成新的候选编号。"""
    app, client = platform
    await bootstrap_studio(client)
    media = app.state.services.media_jobs
    await media.close()
    uri, saved = await create_quick(client)
    identities = []
    for number in (1, 2):
        plan = await make_plan(client, uri, saved["revision"], f"sequence-{number}")
        response = await client.post(
            uri + "/quick/generation-plans/" + plan["id"] + "/confirm",
            json={
                "revision": plan["revision"],
                "requestKey": f"confirm-sequence-{number}",
                "planHash": plan["planHash"],
            },
        )
        assert response.status_code == 200, response.text
        identity = response.json()["jobs"][0]["id"]
        identities.append(identity)
        async with media.database.sessions.begin() as session:
            row = await session.get(MediaJob, identity)
            assert row is not None
            row.state = "failed"
    async with media.database.sessions.begin() as session:
        first = await session.get(MediaJob, identities[0])
        assert first is not None
        first.error = "旧候选稍后收到核对结果"
    jobs = (await client.get(uri + "/quick")).json()["jobs"]
    assert [job["id"] for job in jobs] == list(reversed(identities))
    assert [job["candidateNumber"] for job in jobs] == [2, 1]


async def test_quick_freeze_candidate_collect_and_promote(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap_studio(client)
    media = app.state.services.media_jobs
    await media.close()
    capability = (await client.get("/api/studio/quick-capabilities")).json()
    assert capability["defaultConfigurationId"] == "text"
    assert next(model for model in capability["models"] if model["id"] == "reference")[
        "inputModes"
    ] == ["image", "reference"]
    uri, saved = await create_quick(client)
    project_id = saved["id"]
    doc = (await client.get(uri)).json()
    assert doc["document"]["script"] == saved["draft"]["prompt"]
    assert not doc["document"]["shots"]
    directory = (
        await client.get("/api/studio/projects", params={"page": 1, "mode": "quick"})
    ).json()
    assert directory["total"] == 1 and directory["items"][0]["creationMode"] == "quick"
    assert (
        await client.get("/api/studio/projects", params={"page": 1, "mode": "storyboard"})
    ).json()["total"] == 0
    plan = await make_plan(client, uri, saved["revision"], "first-video")
    assert len(plan["items"]) == 1 and not plan["issues"]
    confirm = {
        "revision": plan["revision"],
        "requestKey": "confirm",
        "planHash": plan["planHash"],
    }
    first, replay = await asyncio.gather(
        *(
            client.post(uri + "/quick/generation-plans/" + plan["id"] + "/confirm", json=confirm)
            for _ in range(2)
        )
    )
    assert first.status_code == replay.status_code == 200, first.text
    assert first.json() == replay.json()
    job_id = first.json()["jobs"][0]["id"]
    assert (await make_plan(client, uri, saved["revision"], "second-active"))["issues"]
    # 草稿在生成期间可继续修改；后台任务和以后采用仍绑定原输入。
    changed = await client.put(
        uri + "/quick",
        json={
            "revision": saved["revision"],
            "requestKey": "next-draft",
            "title": "下一条创意",
            "draft": {**saved["draft"], "prompt": "下一条是海边", "aspect": "9:16"},
        },
    )
    assert changed.status_code == 200, changed.text
    media.root.mkdir(parents=True, exist_ok=True)
    await media.renderer.command(
        media.root,
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x180:r=25",
            "-t",
            "5",
            "-c:v",
            "libx264",
            "quick-fixture.mp4",
        ],
    )
    video = (media.root / "quick-fixture.mp4").read_bytes()
    posts: list[dict] = []

    def provider(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            posts.append(json.loads(request.content))
            return httpx.Response(200, json={"output": {"task_id": "quick-task"}})
        if "/tasks/" in request.url.path:
            return httpx.Response(
                200,
                json={
                    "output": {
                        "task_status": "SUCCEEDED",
                        "video_url": "https://files.invalid/quick.mp4",
                    }
                },
            )
        return httpx.Response(200, content=video)

    media.models.transport = ProviderTransport(transport=httpx.MockTransport(provider))
    for _ in range(2):
        async with media.database.sessions() as session:
            row = await session.get(MediaJob, job_id)
        assert row is not None
        await media.process(row)
    ready = (await client.get(uri + "/quick")).json()
    assert ready["jobs"][0]["state"] == "ready", ready
    charged_wallet = (await client.get("/api/me/billing")).json()
    assert charged_wallet["unlimited"] and (
        charged_wallet["availablePoints"],
        charged_wallet["heldPoints"],
    ) == (2000, 0)
    assert len(posts) == 1 and posts[0]["input"]["prompt"] == "两只小狗踏上月球"
    assert ready["draft"]["prompt"] == "下一条是海边"
    assert ready["jobs"][0]["quickDraft"]["prompt"] == "两只小狗踏上月球"
    assert (await client.post(uri + "/media/" + job_id + "/access")).status_code == 200
    streamed = await client.get(uri + "/media/" + job_id, headers={"Range": "bytes=0-99"})
    assert streamed.status_code == 206 and len(streamed.content) == 100
    collect = {
        "revision": ready["revision"],
        "requestKey": "collect-one",
        "jobId": job_id,
        "name": "登月片段",
    }
    collected = await client.post(uri + "/quick/collect", json=collect)
    assert collected.status_code == 200, collected.text
    assert collected.json()["project"] is None
    assert (await client.post(uri + "/quick/collect", json=collect)).json() == collected.json()
    promotion = {
        "revision": ready["revision"],
        "requestKey": "promote",
        "jobId": job_id,
    }
    promoted = await client.post(uri + "/quick/promote", json=promotion)
    assert promoted.status_code == 200, promoted.text
    assert (await client.post(uri + "/quick/promote", json=promotion)).json() == promoted.json()
    studio = (await client.get(uri)).json()
    assert studio["id"] == project_id and studio["creationMode"] == "storyboard"
    assert studio["document"]["shots"][0]["candidate"] == job_id
    assert studio["aspectWidth"] == 16 and studio["aspectHeight"] == 9
    assert studio["document"]["script"] == "两只小狗踏上月球"
    assert len(studio["jobs"]) == 1


async def test_quick_conflicts_preflight_and_account_isolation(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap_studio(client)
    await app.state.services.media_jobs.close()
    uri, saved = await create_quick(client)
    body = {
        "revision": saved["revision"],
        "requestKey": "safe-save",
        "title": saved["title"],
        "draft": saved["draft"],
    }
    response = await client.put(uri + "/quick", json=body)
    assert response.status_code == 200
    assert (await client.put(uri + "/quick", json=body)).json() == response.json()
    assert (await client.put(uri + "/quick", json={**body, "title": "冲突"})).status_code == 409
    assert (
        await client.put(uri + "/quick", json={**body, "requestKey": "stale"})
    ).status_code == 409
    state = (await client.get(uri + "/quick")).json()
    planned = await make_plan(client, uri, state["revision"], "stale-plan")
    empty = await client.put(
        uri + "/quick",
        json={
            **body,
            "revision": state["revision"],
            "requestKey": "empty",
            "draft": {**saved["draft"], "prompt": ""},
        },
    )
    confirm = {
        "revision": planned["revision"],
        "requestKey": "confirm-stale",
        "planHash": planned["planHash"],
    }
    assert (
        await client.post(
            uri + "/quick/generation-plans/" + planned["id"] + "/confirm", json=confirm
        )
    ).status_code == 409
    blocked = await make_plan(client, uri, empty.json()["revision"], "no-prompt")
    assert blocked["issues"] and not (await client.get(uri + "/quick")).json()["jobs"]
    account = await app.state.services.identity.authenticate(login["accessToken"])
    image = io.BytesIO()
    Image.new("RGB", (400, 400), "white").save(image, "PNG")
    file = await app.state.services.files.ingest(account, "角色.png", image.getvalue(), "image/png")
    asset = (
        await client.post(
            "/api/studio/assets",
            json={"kind": "character", "name": "小白", "fileId": file["id"]},
        )
    ).json()
    reference = await client.put(
        uri + "/quick",
        json={
            **body,
            "revision": empty.json()["revision"],
            "requestKey": "one-reference",
            "draft": {
                **saved["draft"],
                "inputMode": "image",
                "configurationId": "reference",
                "references": [asset["id"]],
            },
        },
    )
    assert reference.status_code == 200, reference.text
    assert not (await make_plan(client, uri, reference.json()["revision"], "image-plan"))["issues"]
    other = await client.post(
        "/api/admin/users",
        json={
            "username": "quickother",
            "password": "Another123!",
            "displayName": "另一创作者",
            "roles": ["entertainment_creator"],
        },
    )
    assert other.status_code == 201, other.text
    token = await complete_initial_login(client, "quickother", "Another123!")
    headers = {"Authorization": "Bearer " + str(token["accessToken"])}
    assert (await client.get(uri + "/quick", headers=headers)).status_code == 404
    assert (
        await client.put(
            uri + "/quick",
            headers=headers,
            json={**body, "revision": reference.json()["revision"]},
        )
    ).status_code == 404
    assert (
        await client.post(
            uri + "/quick/generation-plans",
            headers=headers,
            json={"revision": reference.json()["revision"], "requestKey": "foreign"},
        )
    ).status_code == 404


async def test_quick_cancel_reconcile_regenerate_and_readonly(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    login = await bootstrap_studio(client)
    media = app.state.services.media_jobs
    await media.close()
    uri, saved = await create_quick(client)

    async def confirm(plan: dict) -> dict:
        response = await client.post(
            uri + "/quick/generation-plans/" + plan["id"] + "/confirm",
            json={
                "revision": plan["revision"],
                "requestKey": "confirm-" + plan["id"],
                "planHash": plan["planHash"],
            },
        )
        assert response.status_code == 200, response.text
        return response.json()["jobs"][0]

    first = await confirm(await make_plan(client, uri, saved["revision"], "cancelled-video"))
    actions = "/api/studio/jobs/" + first["id"] + "/actions"
    body = {"revision": first["revision"], "requestKey": "cancel-before-submit", "action": "cancel"}
    cancelled = await client.post(actions, json=body)
    assert cancelled.status_code == 200 and cancelled.json()["state"] == "cancelled"
    assert (await client.post(actions, json=body)).json() == cancelled.json()
    refunded_wallet = (await client.get("/api/me/billing")).json()
    assert (refunded_wallet["availablePoints"], refunded_wallet["heldPoints"]) == (2000, 0)
    second = await confirm(await make_plan(client, uri, saved["revision"], "unknown-video"))
    async with media.database.sessions.begin() as session:
        row = await session.get(MediaJob, second["id"])
        assert row is not None
        row.state = "unknown"
    blocked = await make_plan(client, uri, saved["revision"], "unknown-preflight")
    assert blocked["issues"]
    explicit = {
        "revision": saved["revision"],
        "requestKey": "explicit-resubmit",
        "allowDuplicate": True,
    }
    assert (await client.post(uri + "/quick/generation-plans", json=explicit)).status_code == 422
    allowed = await client.post(
        uri + "/quick/generation-plans", json={**explicit, "reason": "已人工核对，接受重复生成风险"}
    )
    assert allowed.status_code == 200 and not allowed.json()["issues"]
    third = await confirm(allowed.json())
    async with media.database.sessions.begin() as session:
        uncertain = await session.get(MediaJob, second["id"])
        current = await session.get(MediaJob, third["id"])
        assert uncertain is not None and current is not None
        assert (
            uncertain.state == "unknown"
            and uncertain.payload["replacementPlan"] == allowed.json()["id"]
        )
        current.state = "ready"
    same = await make_plan(client, uri, saved["revision"], "ready-repeat")
    assert same["issues"] and "再生成" in same["issues"][0]["message"]
    again = await client.post(
        uri + "/quick/generation-plans",
        json={"revision": saved["revision"], "requestKey": "ready-approved", "regenerate": True},
    )
    assert again.status_code == 200 and not again.json()["issues"]
    account = await app.state.services.identity.authenticate(login["accessToken"])
    readonly = replace(account, permissions=("products.entertainment", "studio.projects.read"))

    async def acting(_request: Request) -> Account:
        return readonly

    monkeypatch.setattr(dependencies, "current_account", acting)
    response = await client.get(uri + "/quick")
    assert response.status_code == 200 and response.json()["capabilities"]["models"] == []
    assert (
        await client.post(
            uri + "/quick/generation-plans",
            json={"revision": saved["revision"], "requestKey": "readonly"},
        )
    ).status_code == 403
    assert (
        await client.put(
            uri + "/quick",
            json={
                "revision": saved["revision"],
                "requestKey": "readonly-save",
                "title": "修改",
                "draft": saved["draft"],
            },
        )
    ).status_code == 403


@pytest.mark.parametrize("platform_configuration", ["00895f4a6c12"], indirect=True)
async def test_quick_migration_preserves_existing_project(
    platform_configuration: Settings,
) -> None:
    engine = create_async_engine(platform_configuration.database_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                insert(UserRow).values(
                    id="owner", username="owner", password_hash="synthetic", roles=["admin"]
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_projects(id,owner,title,revision) VALUES ('old','owner','原作品',7)"
                )
            )
        await upgrade_database(platform_configuration.database_url, "00a0c71e9f22")
        async with engine.connect() as connection:
            row = (
                await connection.execute(
                    text(
                        "SELECT owner,title,revision,creation_mode,quick_draft FROM studio_projects WHERE id='old'"
                    )
                )
            ).one()
            assert tuple(row) == ("owner", "原作品", 7, "storyboard", {})
    finally:
        await engine.dispose()
