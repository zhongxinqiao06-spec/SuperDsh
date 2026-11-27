"""个人会员切片的真实数据库、版本选择与归属边界。"""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import bootstrap, upgrade_database
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import insert, select, text, update
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.billing.dao.membership_dao import MembershipRepository
from app.modules.billing.entity.do.credit_do import CreditLotRow, LedgerEntryRow
from app.modules.billing.entity.do.plan_do import PlanVersionRow, SubscriptionRow
from app.modules.billing.service.registration_credit import grant_registration_credit
from app.modules.navigation.entity.do.models import NavigationRow


async def test_personal_credit_queries(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    path = "/api/me/billing"
    for url in [
        path,
        path + "/entries",
        path + "/entries/nonexistent",
        path + "/cards",
        "/api/billing/catalog",
    ]:
        assert (await client.get(url)).status_code == 401
    account = await bootstrap(client)
    owner = str(account["userId"])
    empty = (await client.get(path)).json()
    assert (empty["availablePoints"], empty["subscription"], empty["lots"]) == (
        0,
        None,
        [],
    )
    assert (await client.get(path + "/entries")).json() == {
        "items": [],
        "nextCursor": None,
    }
    now = datetime.now(UTC)
    async with app.state.database.sessions.begin() as db:
        assert await db.scalar(text("SELECT count(*) FROM billing_wallets")) == 0
        await db.execute(
            text("""INSERT INTO users
            (id,username,password_hash,roles,disabled,reset_required,auth_version,revision)
            VALUES ('other','other','unused','[]',false,false,0,1)""")
        )
        await grant_registration_credit(db, "other", now)
        await grant_registration_credit(db, owner, now)
        foreign = await db.scalar(
            select(LedgerEntryRow.id).where(LedgerEntryRow.user_id == "other")
        )
        lot_id = await db.scalar(select(CreditLotRow.id).where(CreditLotRow.user_id == owner))
        for idx, days, held in [(0, -1, 2), (1, 2, 3)]:
            await db.execute(
                insert(CreditLotRow).values(
                    id=f"lot{idx}",
                    user_id=owner,
                    source_key=f"bonus-{idx}",
                    granted=10,
                    remaining=10,
                    held=held,
                    created_at=now - timedelta(days=2),
                    expires_at=now + timedelta(days=days),
                )
            )
        for key in ["tie-a", "tie-b", "tie-c"]:
            await db.execute(
                insert(LedgerEntryRow).values(
                    id=key,
                    user_id=owner,
                    lot_id=lot_id,
                    kind="adjustment",
                    event_key=key,
                    available_delta=1,
                    held_delta=0,
                    created_at=now,
                )
            )
        await db.execute(
            insert(SubscriptionRow).values(
                user_id=owner,
                plan_version_id="light-1",
                plan_kind="membership",
                starts_at=now - timedelta(days=1),
                ends_at=now + timedelta(days=29),
                next_grant_at=None,
            )
        )
    wallet = (await client.get(path + "?userId=other")).json()
    assert (
        wallet["availablePoints"],
        wallet["heldPoints"],
        wallet["expiringPoints"],
    ) == (207, 5, 7)
    assert wallet["lots"][0]["availablePoints"] == 0 and wallet["lots"][0]["held"] == 2
    assert wallet["subscription"]["plan"]["priceFen"] == 2900
    assert (await client.get(path + "/entries/" + foreign)).status_code == 404
    assert (await client.get(path + "/entries", params={"cursor": foreign})).status_code == 422
    first = (await client.get(path + "/entries?kind=adjustment&limit=2")).json()
    assert [i["id"] for i in first["items"]] == ["tie-c", "tie-b"]
    last = (
        await client.get(path + "/entries?kind=adjustment&limit=2&cursor=" + first["nextCursor"])
    ).json()
    assert [i["id"] for i in last["items"]] == ["tie-a"] and last["nextCursor"] is None
    detail = (await client.get(path + "/entries/tie-b")).json()
    assert detail["lotId"] == lot_id and detail["sourceKey"] == "card:registration"
    assert (await client.get(path + "/entries?since=2026-01-01")).status_code == 422
    future = now + timedelta(days=1)
    assert (await client.get(path + "/entries", params={"since": future.isoformat()})).json()[
        "items"
    ] == []
    async with app.state.database.sessions.begin() as db:
        await db.execute(
            update(SubscriptionRow).values(starts_at=now - timedelta(days=2), ends_at=now)
        )
    assert (await client.get(path)).json()["subscription"] is None


async def test_wallet_at_exact_expiry(platform: tuple[FastAPI, AsyncClient]) -> None:
    """固定时刻核对到期边界与摘要截断，批次列表长度不影响总额。"""
    app, client = platform
    owner = str((await bootstrap(client))["userId"])
    now = datetime.now(UTC)
    async with app.state.database.sessions.begin() as db:
        await grant_registration_credit(db, owner, now - timedelta(days=30))
        for index, offset in enumerate([timedelta(days=7), timedelta(days=7, microseconds=1)]):
            await db.execute(
                insert(CreditLotRow).values(
                    id=f"boundary-{index}",
                    user_id=owner,
                    source_key=f"grant-{index}",
                    granted=10,
                    remaining=10,
                    held=2,
                    created_at=now,
                    expires_at=now + offset,
                )
            )
    wallet = await MembershipRepository(app.state.database).wallet(owner, now, 7, 1)
    assert (wallet.available_points, wallet.held_points, wallet.expiring_points) == (
        16,
        4,
        8,
    )
    assert wallet.has_more_lots and [lot.id for lot in wallet.lots] == ["boundary-0"]


async def test_effective_catalog(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    await bootstrap(client)
    path = "/api/billing/catalog"
    catalog = (await client.get(path)).json()
    assert catalog["saleOpen"] is False
    assert [(p["priceFen"], p["points"], p["weeklyPoints"]) for p in catalog["items"]] == [
        (1900, 180, None),
        (2900, 500, 200),
        (6900, 1500, 500),
        (19900, 3000, 1000),
    ]
    now = datetime.now(UTC)
    async with app.state.database.sessions.begin() as db:
        for rev, listed, when in [(2, False, now), (3, True, now + timedelta(days=2))]:
            await db.execute(
                insert(PlanVersionRow).values(
                    id=f"pro-{rev}",
                    sku="pro",
                    revision=rev,
                    name="修订",
                    kind="membership",
                    term_unit="month",
                    price_fen=19900,
                    points=2600,
                    listed=listed,
                    effective_at=when,
                )
            )
    assert "pro" not in [p["sku"] for p in (await client.get(path)).json()["items"]]


@pytest.mark.parametrize("platform_configuration", ["02ce84b7dbf3"], indirect=True)
async def test_upgrade_preserves_menu_settings(
    platform_configuration: Settings,
) -> None:
    engine = create_async_engine(platform_configuration.database_url)
    group: dict[str, object] = dict(
        id="account.membership",
        moduleId=None,
        kind="group",
        parentId=None,
        order=0,
        visible=True,
        roleIds=[],
        title="自选",
        icon="user",
    )
    profile = dict(
        id="account.profile",
        moduleId="account.profile",
        kind="page",
        parentId=group["id"],
        order=10000,
        visible=False,
        roleIds=["limited"],
        title="我的档案",
        icon="user",
    )
    try:
        async with engine.begin() as conn:
            for key in ["global", "entertainment"]:
                await conn.execute(
                    insert(NavigationRow).values(id=key, version=8, items=[group, profile])
                )
        await upgrade_database(platform_configuration.database_url)
        async with engine.connect() as conn:
            rows = (await conn.execute(select(NavigationRow.version, NavigationRow.items))).all()
            assert len(rows) == 2
            for version, (saved_group, original, added, cards) in rows:
                assert (
                    cards["moduleId"] == "account.cards" and cards["parentId"] == added["parentId"]
                )
                assert not cards["visible"] and cards["roleIds"] == ["limited"]
                assert version == 10 and original["title"] == "我的档案"
                assert added["id"] == "account.membership" and not added["visible"]
                assert added["roleIds"] == ["limited"] and added["order"] == 10000
                assert added["parentId"] == original["parentId"] == saved_group["id"]
    finally:
        await engine.dispose()
