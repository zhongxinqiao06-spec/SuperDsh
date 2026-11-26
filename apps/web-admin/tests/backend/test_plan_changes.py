"""验证换档仅影响首个未购周期，以及预约、确认、撤销的并发与权限边界。"""

import asyncio
from datetime import UTC, datetime, timedelta, tzinfo
from uuid import uuid4

import pytest
from conftest import bootstrap, complete_initial_login, upgrade_database
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.billing.dao.membership_dao import MembershipRepository
from app.modules.billing.service import change_service, operations_service

BASE = "/api/admin/billing"


def cmd(rev: int, **extras: object) -> dict[str, object]:
    return {"expectedRevision": rev, "businessKey": str(uuid4()), "reason": "合成换档", **extras}


async def operation(
    client: AsyncClient, owner: str, action: str, plan: str, *, confirm: bool = True
) -> dict:
    r = await client.post(
        BASE + "/operation-previews",
        json={
            "userId": owner,
            "action": action,
            "businessKey": str(uuid4()),
            "reason": "核对合成周期",
            "planVersionId": plan,
            "payment": "offline",
            "receivedFen": {"light-1": 2900, "creator-1": 6900}[plan],
            "receipt": str(uuid4()),
        },
    )
    assert r.status_code == 200, r.text
    if confirm:
        r = await client.post(BASE + "/subscriptions", json={"previewId": r.json()["id"]})
        assert r.status_code == 200, r.text
    return r.json()


async def account(client: AsyncClient, owner: str) -> dict:
    return (await client.get(BASE + "/subscriptions", params={"userId": owner})).json()["items"][0]


async def test_paid_boundary_and_reversal(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    owner = str((await bootstrap(client))["userId"])
    path = f"{BASE}/subscriptions/{owner}/changes"
    await operation(client, owner, "open", "light-1")
    paid = await operation(client, owner, "renew", "light-1")
    before = await account(client, owner)
    request = cmd(before["revision"], planVersionId="creator-1")
    r = await client.post(path, json=request)
    assert r.status_code == 200, r.text
    change = r.json()
    assert change["effectiveAt"] == paid["quote"]["endsAt"]
    assert (await client.post(path, json=request)).json()["id"] == change["id"]
    snapshot = (await client.get("/api/me/billing")).json()
    assert snapshot["availablePoints"] == 300 and snapshot["planChange"]["state"] == "scheduled"
    assert "actorId" not in snapshot["planChange"] and "reason" not in snapshot["planChange"]
    new = await operation(client, owner, "renew", "creator-1")
    assert (
        new["quote"]["startsAt"] == change["effectiveAt"] and new["quote"]["immediatePoints"] == 0
    )
    current = await account(client, owner)
    assert current["planSku"] == "light" and current["lastBookedSku"] == "creator"
    assert current["planChange"]["state"] == "booked"
    await operation(client, owner, "renew", "creator-1")
    current = await account(client, owner)
    cancel = cmd(current["revision"])
    r = await client.request("DELETE", path + "/" + change["id"], json=cancel)
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    assert (
        await client.request("DELETE", path + "/" + change["id"], json=cancel)
    ).json() == r.json()
    back = (await account(client, owner))["planChange"]
    assert back["toPlanSku"] == "light" and back["effectiveAt"] == current["endsAt"]
    history = (await client.get(path)).json()["items"]
    assert len(history) == 2 and history[0]["restoresChangeId"] == change["id"]
    personal = (await client.get("/api/me/billing")).json()
    assert personal["subscription"]["nextBookedPlan"] == {
        "name": "创作会员",
        "startsAt": new["quote"]["startsAt"],
    }
    repository = MembershipRepository(app.state.database)
    for at, points, sku in [
        (paid["quote"]["startsAt"], 300, "light"),
        (new["quote"]["startsAt"], 800, "creator"),
    ]:
        w = await repository.wallet(owner, datetime.fromisoformat(at), 7, 20)
        assert w.available_points == points and w.subscription and w.subscription.plan.sku == sku


async def test_cancel_conflicts_and_stale_preview(platform: tuple[FastAPI, AsyncClient]) -> None:
    _, client = platform
    owner = str((await bootstrap(client))["userId"])
    path = f"{BASE}/subscriptions/{owner}/changes"
    await operation(client, owner, "open", "light-1")
    rev = (await account(client, owner))["revision"]
    assert (await client.post(path, json=cmd(rev, planVersionId="extra-1"))).status_code == 422
    assert (await client.post(path, json=cmd(rev, planVersionId="light-1"))).status_code == 422
    old_quote = await operation(client, owner, "renew", "light-1", confirm=False)
    payload = cmd(rev, planVersionId="creator-1")
    results = await asyncio.gather(
        client.post(path, json=payload), client.post(path, json=cmd(rev, planVersionId="pro-1"))
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    current = await account(client, owner)
    change = current["planChange"]
    assert (
        await client.post(BASE + "/subscriptions", json={"previewId": old_quote["id"]})
    ).status_code == 409
    if change["toVersionId"] == "creator-1":
        assert (await client.post(path, json={**payload, "reason": "改写原因"})).status_code == 409
    assert (
        await client.request("DELETE", path + "/" + change["id"], json=cmd(rev))
    ).status_code == 409
    canceled = await client.request(
        "DELETE", path + "/" + change["id"], json=cmd(current["revision"])
    )
    assert canceled.status_code == 200
    assert (await account(client, owner))["planChange"] is None
    assert (await client.get("/api/me/billing")).json()["availablePoints"] == 300
    await operation(client, owner, "renew", "light-1")


async def test_unfunded_and_effective_dates(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    owner = str((await bootstrap(client))["userId"])
    path = f"{BASE}/subscriptions/{owner}/changes"
    first = await operation(client, owner, "open", "light-1")
    rev = (await account(client, owner))["revision"]
    change = (await client.post(path, json=cmd(rev, planVersionId="creator-1"))).json()
    at = datetime.fromisoformat(first["quote"]["endsAt"]) + timedelta(hours=1)

    class Clock(datetime):
        @classmethod
        def now(cls, tz: tzinfo | None = None) -> "Clock":
            return cls.fromtimestamp(at.timestamp(), tz or UTC)

    monkeypatch.setattr(operations_service, "datetime", Clock)
    monkeypatch.setattr(change_service, "datetime", Clock)
    wallet = await MembershipRepository(app.state.database).wallet(owner, at, 7, 20)
    assert (
        wallet.subscription is None
        and wallet.available_points == 0
        and wallet.plan_change
        and wallet.plan_change.state == "due"
    )
    open_again = await operation(client, owner, "open", "creator-1")
    assert open_again["quote"]["immediatePoints"] == 800
    current = await account(client, owner)
    assert current["planSku"] == "creator"
    reject = await client.request(
        "DELETE", path + "/" + change["id"], json=cmd(current["revision"])
    )
    assert reject.status_code == 409
    assert reject.json()["currentSubscription"]["plan"]["sku"] == "creator"
    history = (await client.get(path)).json()["items"]
    assert history[0]["state"] == "effective"


async def test_renewal_races_reservation(platform: tuple[FastAPI, AsyncClient]) -> None:
    _, client = platform
    owner = str((await bootstrap(client))["userId"])
    path = f"{BASE}/subscriptions/{owner}/changes"
    await operation(client, owner, "open", "light-1")
    before = await account(client, owner)
    renewal = await operation(client, owner, "renew", "light-1", confirm=False)
    booked, scheduled = await asyncio.gather(
        client.post(BASE + "/subscriptions", json={"previewId": renewal["id"]}),
        client.post(path, json=cmd(before["revision"], planVersionId="creator-1")),
    )
    assert sorted([booked.status_code, scheduled.status_code]) == [200, 409]
    after = await account(client, owner)
    assert after["revision"] == before["revision"] + 1
    assert after["availablePoints"] == before["availablePoints"]
    if booked.is_success:
        assert after["endsAt"] == renewal["quote"]["endsAt"] and after["planChange"] is None
        assert (
            await client.post(path, json=cmd(after["revision"], planVersionId="creator-1"))
        ).is_success
        after = await account(client, owner)
    else:
        assert after["endsAt"] == after["planChange"]["effectiveAt"] == before["endsAt"]
    # 两次选择同一个版本仍是两条不同的预约，旧预览不能确认到新预约上。
    stale = await operation(client, owner, "renew", "creator-1", confirm=False)
    change = after["planChange"]
    assert (
        await client.request("DELETE", path + "/" + change["id"], json=cmd(after["revision"]))
    ).is_success
    latest = await account(client, owner)
    assert (
        await client.post(path, json=cmd(latest["revision"], planVersionId="creator-1"))
    ).is_success
    assert (
        await client.post(BASE + "/subscriptions", json={"previewId": stale["id"]})
    ).status_code == 409


async def test_restricted_customer(platform: tuple[FastAPI, AsyncClient]) -> None:
    _, client = platform
    owner = str((await bootstrap(client))["userId"])
    path = f"{BASE}/subscriptions/{owner}/changes"
    await operation(client, owner, "open", "light-1")
    pwd = "Synthetic-password-123!"
    await client.post(
        "/api/admin/users",
        json=dict(
            username="switch-test", displayName="合成普通用户", password=pwd, roles=["member"]
        ),
    )
    restricted = await complete_initial_login(client, "switch-test", pwd)
    headers = {"Authorization": "Bearer " + str(restricted["accessToken"])}
    assert (await client.get(path, headers=headers)).status_code == 403
    assert (
        await client.post(path, headers=headers, json=cmd(1, planVersionId="creator-1"))
    ).status_code == 403
    assert (
        await client.request("DELETE", path + "/missing", headers=headers, json=cmd(1))
    ).status_code == 403


@pytest.mark.parametrize("platform_configuration", ["04ae16d9fa15"], indirect=True)
async def test_upgrade_snapshot(platform_configuration: Settings) -> None:
    url = platform_configuration.database_url
    engine = create_async_engine(url)
    try:
        async with engine.begin() as db:
            await db.execute(
                text("""INSERT INTO users (id,username,password_hash,roles,disabled,reset_required,auth_version,revision)
              VALUES ('holder','holder','fixture','["member"]',false,false,0,1)""")
            )
            await db.execute(
                text("""INSERT INTO billing_subscriptions(user_id,plan_version_id,plan_kind,starts_at,ends_at)
               VALUES ('holder','light-1','membership',now(),now()+interval '1 month')""")
            )
        await upgrade_database(url)
        async with engine.connect() as db:
            assert (
                await db.execute(
                    text(
                        "SELECT plan_version_id,revision FROM billing_subscriptions WHERE user_id='holder'"
                    )
                )
            ).one() == ("light-1", 1)
            assert await db.scalar(text("SELECT count(*) FROM billing_subscription_changes")) == 0
    finally:
        await engine.dispose()
