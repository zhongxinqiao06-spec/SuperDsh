"""通过真实 HTTP、数据库与迁移校验商品发布、权益冻结及授权。"""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.billing.dao.membership_dao import MembershipRepository

BASE = "/api/admin/billing/plans"
OPS = "/api/admin/billing"


def publish(rev: int = 1, /, **overrides: object) -> dict[str, object]:
    return dict(
        {
            "businessKey": str(uuid4()),
            "reason": "试行调整",
            "expectedRevision": rev,
            "name": "创作会员",
            "kind": "membership",
            "termUnit": "month",
            "priceFen": 7900,
            "points": 950,
            "listed": True,
        },
        **overrides,
    )


async def test_publication_does_not_reprice_purchases(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    owner = (await bootstrap(client))["userId"]

    async def preview(action: str, plan: str) -> dict:
        r = await client.post(
            OPS + "/operation-previews",
            json={
                "action": action,
                "businessKey": str(uuid4()),
                "userId": owner,
                "reason": "合成办理",
                "planVersionId": plan,
            },
        )
        assert r.is_success, r.text
        return r.json()

    first = await preview("open", "creator-1")
    assert (await client.post(OPS + "/subscriptions", json={"previewId": first["id"]})).is_success
    old = await preview("renew", "creator-1")
    payload = publish()
    path = BASE + "/creator/versions"
    r = await client.post(path, json=payload)
    assert r.is_success, r.text
    version = r.json()
    assert version["weeklyPoints"] == 500
    assert version["revision"] == 2 and version["publishedBy"] == owner
    assert (await client.post(path, json=payload)).json()["id"] == version["id"]
    assert (await client.post(path, json={**payload, "points": 1})).status_code == 409
    assert (await client.post(path, json=publish(2))).status_code == 422
    assert (
        await client.post(OPS + "/subscriptions", json={"previewId": old["id"]})
    ).status_code == 409
    wallet = (await client.get("/api/me/billing")).json()
    assert wallet["subscription"]["plan"]["priceFen"] == 6900 and wallet["availablePoints"] == 500
    new = await preview("renew", version["id"])
    assert (new["quote"]["priceFen"], new["quote"]["points"]) == (7900, 950)
    history = (await client.get(path, params={"page": 2, "pageSize": 1})).json()
    assert history["total"] == 2 and history["items"][0]["id"] == "creator-1"


async def test_future_offsale_withdraw_and_relist(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)
    repo = MembershipRepository(app.state.database)
    start = datetime.now(UTC) + timedelta(days=2)
    path = BASE + "/creator/versions"
    body = publish(effectiveAt=start.isoformat(), listed=False)
    r = await client.post(path, json=body)
    assert r.is_success, r.text
    assert any(p.sku == "creator" for p in await repo.plans(start - timedelta(seconds=1)))
    assert all(p.sku != "creator" for p in await repo.plans(start))
    series = (await client.get(BASE, params={"search": "creator"})).json()["items"][0]
    assert series["current"]["id"] == "creator-1" and series["upcoming"]["revision"] == 2
    assert (await client.post(path, json=publish(2))).status_code == 409
    cmd = {"businessKey": str(uuid4()), "reason": "延后执行"}
    assert (await client.post(path + "/2/withdraw", json=cmd)).is_success
    assert (await client.post(path + "/2/withdraw", json=cmd)).is_success
    assert any(p.sku == "creator" for p in await repo.plans(start))
    off = await client.post(path, json=publish(2, listed=False))
    assert off.is_success and off.json()["revision"] == 3
    assert (
        await client.post(path + "/3/withdraw", json={**cmd, "businessKey": str(uuid4())})
    ).status_code == 409
    assert "creator" not in [
        p["sku"] for p in (await client.get("/api/billing/catalog")).json()["items"]
    ]
    assert (await client.post(path, json=publish(3))).is_success
    hist = (await client.get(path)).json()["items"]
    assert [v["revision"] for v in hist] == [4, 3, 2, 1] and hist[2]["withdrawReason"] == "延后执行"
    public = (await client.get("/api/billing/catalog")).json()["items"]
    assert any(p["sku"] == "creator" for p in public) and all(
        "publishedBy" not in p for p in public
    )


async def test_catalog_conflicts_validation_and_rbac(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client)
    path = BASE + "/annual/versions"
    args = publish(0, name="年费", termUnit="year")
    results = await asyncio.gather(
        client.post(path, json=args),
        client.post(path, json={**args, "businessKey": str(uuid4())}),
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    assert (await client.post(path, json=publish(1, kind="addon"))).status_code == 422
    invalid: list[dict[str, object]] = [
        {"priceFen": -1},
        {"points": 1.5},
        {"weeklyPoints": 0},
        {"weeklyPoints": 1.25},
        {"weeklyPoints": 951},
        {"kind": "addon", "weeklyPoints": 1},
        {"termUnit": "year", "points": 178956971},
        {"effectiveAt": "2030-01-01T00:00:00"},
        {"effectiveAt": "2001-01-01T00:00:00Z"},
    ]
    for changes in invalid:
        assert (await client.post(path, json=publish(**changes))).status_code == 422
    role = (
        await client.post(
            "/api/admin/roles",
            json={
                "name": "合成账务查看",
                "description": "",
                "permissions": ["products.office", "billing.read"],
            },
        )
    ).json()
    user = "catalog-reader"
    pwd = "Synthetic-password-123!"
    assert (
        await client.post(
            "/api/admin/users",
            json={
                "username": user,
                "password": pwd,
                "roles": [role["id"]],
                "displayName": "查看员",
            },
        )
    ).is_success
    token = (await complete_initial_login(client, user, pwd))["accessToken"]
    headers = {"Authorization": "Bearer " + str(token)}
    assert (await client.get(BASE, headers=headers)).is_success
    assert (await client.post(path, json=publish(), headers=headers)).status_code == 403
    assert (
        await client.post(
            path + "/1/withdraw",
            json={"reason": "测试", "businessKey": str(uuid4())},
            headers=headers,
        )
    ).status_code == 403


async def test_reservation_requires_current_target_version(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    owner = (await bootstrap(client))["userId"]
    body = {
        "businessKey": str(uuid4()),
        "userId": owner,
        "reason": "延期",
        "action": "open",
        "planVersionId": "light-1",
    }
    quote = (await client.post(OPS + "/operation-previews", json=body)).json()
    assert (await client.post(OPS + "/subscriptions", json={"previewId": quote["id"]})).is_success
    path = OPS + "/subscriptions/" + str(owner) + "/changes"
    cmd = {
        "expectedRevision": 1,
        "businessKey": str(uuid4()),
        "reason": "新档",
        "planVersionId": "creator-1",
    }
    change = (await client.post(path, json=cmd)).json()
    new = (await client.post(BASE + "/creator/versions", json=publish())).json()
    for version_id in [new["id"], "creator-1"]:
        r = await client.post(
            OPS + "/operation-previews",
            json={
                **body,
                "businessKey": str(uuid4()),
                "action": "renew",
                "planVersionId": version_id,
            },
        )
        assert r.status_code == 409
    assert (
        await client.request(
            "DELETE",
            path + "/" + change["id"],
            json={
                "expectedRevision": 2,
                "businessKey": str(uuid4()),
                "reason": "核对新版",
            },
        )
    ).is_success
    assert (
        await client.post(
            path,
            json={
                **cmd,
                "expectedRevision": 3,
                "businessKey": str(uuid4()),
                "planVersionId": new["id"],
            },
        )
    ).is_success
