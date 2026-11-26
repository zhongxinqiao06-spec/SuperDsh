"""真实 PostgreSQL 迁移与 HTTP 定价流程，试算和任务不调用付费服务。"""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient

ROOT = "/api/admin/billing/"
QUOTE = "/api/billing/usage-quotes"


def video() -> dict:
    return dict(
        product="entertainment",
        capability="video.generate",
        model="text",
        modelRevision=1,
        spec="720P",
        payer="platform",
    )


async def test_drafts_trials_and_quotes(platform: tuple[FastAPI, AsyncClient]) -> None:
    _, client = platform
    await bootstrap(client)
    item = video()
    terms = {**item, "unit": "second", "unitSize": 1, "unitPoints": 25}
    for quantity, expected in [(5, 100), (8, 160)]:
        result = (
            await client.post(
                ROOT + "rate-previews",
                json={"item": dict(item, quantity=quantity), "candidate": terms},
            )
        ).json()
        assert result["current"]["points"] == expected
        assert (
            result["candidate"]["points"] == 25 * quantity and result["difference"] == 5 * quantity
        )
    data = dict(
        businessKey=str(uuid4()),
        source="synthetic",
        items=[dict(item, quantity=8), dict(item, payer="personal", quantity=8)],
    )
    q = (await client.post(QUOTE, json=data)).json()
    assert q["totalPoints"] == 160 and q["lockedAt"] is None
    assert [line["points"] for line in q["items"]] == [160, 0]
    assert (
        await client.post(QUOTE, json=dict(data, items=[dict(item, quantity=5)]))
    ).status_code == 409
    assert (
        await client.post(
            QUOTE,
            json=dict(
                data, businessKey=str(uuid4()), items=[dict(item, quantity=5, spec="unknown")]
            ),
        )
    ).status_code == 422
    body = dict(terms=terms, reason="合成调价", expectedRevision=0, businessKey=str(uuid4()))
    first, second = await asyncio.gather(
        *(client.post(ROOT + "rate-versions", json=body) for _ in range(2))
    )
    assert first.status_code == second.status_code == 200 and first.json() == second.json()
    draft = first.json()
    assert (
        await client.post(ROOT + "rate-versions", json=dict(body, businessKey=str(uuid4())))
    ).status_code == 409
    assert (
        await client.get(ROOT + "rate-versions", params={"state": "draft", "search": "text"})
    ).json()["items"][0]["id"] == draft["id"]
    published = await client.post(
        ROOT + "rate-versions/" + draft["id"] + "/publish", json={"revision": 1}
    )
    assert published.status_code == 200, published.text
    assert (await client.get(QUOTE + "/" + q["id"])).json() == q
    assert (await client.post(QUOTE, json=data)).json() == q
    assert (await client.post(QUOTE, json=dict(data, businessKey=str(uuid4())))).json()[
        "totalPoints"
    ] == 200
    speech = dict(item, capability="speech.synthesize", spec="standard", quantity=101)
    line = (
        await client.post(QUOTE, json=dict(data, businessKey=str(uuid4()), items=[speech]))
    ).json()["items"][0]
    assert (line["units"], line["points"]) == (2, 4)
    body.update(expectedRevision=1, businessKey=str(uuid4()))
    next_row = (await client.post(ROOT + "rate-versions", json=body)).json()
    scheduled = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    assert (
        await client.post(
            ROOT + "rate-versions/" + next_row["id"] + "/publish",
            json={"revision": 2, "effectiveAt": scheduled},
        )
    ).status_code == 200
    body.update(expectedRevision=2, businessKey=str(uuid4()))
    third = (await client.post(ROOT + "rate-versions", json=body)).json()
    assert (
        await client.post(ROOT + "rate-versions/" + third["id"] + "/publish", json={"revision": 3})
    ).status_code == 409


async def test_plan_draft_restore_and_publish(platform: tuple[FastAPI, AsyncClient]) -> None:
    _, client = platform
    await bootstrap(client)
    terms = dict(
        name="独立草稿",
        businessKey=str(uuid4()),
        reason="试行",
        expectedRevision=0,
        kind="membership",
        termUnit="month",
        points=300,
        priceFen=2900,
        listed=True,
    )
    body = dict(sku="draft-only", terms=terms, expectedDraftRevision=0)
    path = ROOT + "plan-versions"
    draft = (await client.post(path, json=body)).json()
    assert draft["id"] == (await client.post(path, json=body)).json()["id"]
    assert not any(
        row["sku"] == "draft-only"
        for row in (await client.get("/api/billing/catalog")).json()["items"]
    )
    updated = (
        await client.post(
            path,
            json=dict(
                body,
                expectedDraftRevision=1,
                terms=dict(terms, points=350, businessKey=str(uuid4())),
            ),
        )
    ).json()
    assert (await client.get(path, params={"search": "draft-only"})).json()["items"] == [updated]
    assert (
        await client.post(path + "/" + draft["id"] + "/publish", json={"revision": 1})
    ).status_code == 409
    url = path + "/" + updated["id"] + "/publish"
    first, second = await asyncio.gather(
        *(client.post(url, json={"revision": 2}) for _ in range(2))
    )
    assert first.status_code == second.status_code == 200 and first.json() == second.json()
    assert (await client.get(path, params={"search": "draft-only"})).json()["total"] == 0
    assert (
        next(
            row
            for row in (await client.get("/api/billing/catalog")).json()["items"]
            if row["sku"] == "draft-only"
        )["points"]
        == 350
    )


async def test_quote_ownership_and_publishing_rights(platform: tuple[FastAPI, AsyncClient]) -> None:
    _, client = platform
    await bootstrap(client)
    data = dict(businessKey=str(uuid4()), source="role-test", items=[dict(video(), quantity=5)])
    own = (await client.post(QUOTE, json=data)).json()
    username = "pricingcreator"
    password = "Synthetic-password-123!"
    created = await client.post(
        "/api/admin/users",
        json=dict(
            username=username,
            password=password,
            displayName="测试创作者",
            roles=["entertainment_creator"],
        ),
    )
    assert created.status_code == 201
    login = await complete_initial_login(client, username, password)
    headers = {"Authorization": "Bearer " + str(login["accessToken"])}
    assert (await client.get(QUOTE + "/" + own["id"], headers=headers)).status_code == 404
    assert (await client.post(QUOTE, json=data, headers=headers)).json()["totalPoints"] == 100
    assert (await client.get(ROOT + "rate-versions", headers=headers)).status_code == 403
    terms = dict(video(), unit="second", unitSize=1, unitPoints=15)
    assert (
        await client.post(
            ROOT + "rate-versions",
            json=dict(terms=terms, businessKey=str(uuid4()), expectedRevision=0, reason="普通用户"),
            headers=headers,
        )
    ).status_code == 403
