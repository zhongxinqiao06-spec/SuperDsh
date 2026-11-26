"""验证账务权限独立、确认重验及从上一会员修订安全升级。"""

from uuid import uuid4

import pytest
from conftest import bootstrap, complete_initial_login, upgrade_database
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.identity.entity.do.models import RoleRow
from app.modules.navigation.entity.do.models import NavigationRow


async def test_clerk_grants_and_revocation(platform: tuple[FastAPI, AsyncClient]) -> None:
    _, client = platform
    target = (await bootstrap(client))["userId"]
    grants = ["products.office", "billing.read", "billing.adjustments.create"]
    role = (
        await client.post(
            "/api/admin/roles",
            json={"name": "合成赠额员", "description": "", "permissions": grants},
        )
    ).json()
    username = "testclerk"
    password = "Synthetic-password-123!"
    response = await client.post(
        "/api/admin/users",
        json={
            "username": username,
            "password": password,
            "displayName": username,
            "roles": [role["id"]],
        },
    )
    assert response.status_code == 201
    clerk = await complete_initial_login(client, username, password)
    headers = {"Authorization": "Bearer " + str(clerk["accessToken"])}
    base = "/api/admin/billing"
    assert (await client.get(base + "/subscriptions", headers=headers)).status_code == 200
    assert (await client.get("/api/admin/users", headers=headers)).status_code == 403
    gift = dict(
        businessKey=str(uuid4()),
        userId=target,
        action="gift",
        points=50,
        validDays=30,
        reason="测试",
    )
    preview = await client.post(base + "/operation-previews", json=gift, headers=headers)
    assert preview.status_code == 200
    key = {"previewId": preview.json()["id"]}
    assert (await client.post(base + "/adjustments", json=key)).status_code == 404
    paid = dict(
        businessKey=str(uuid4()),
        userId=target,
        action="topup",
        planVersionId="extra-1",
        reason="测试",
        payment="offline",
        receipt="fixture",
        receivedFen=1900,
    )
    assert (
        await client.post(base + "/operation-previews", json=paid, headers=headers)
    ).status_code == 403
    update = await client.patch(
        "/api/admin/roles/" + role["id"],
        json={
            "name": role["name"],
            "description": "",
            "permissions": ["products.office", "users.read"],
            "revision": role["revision"],
        },
    )
    assert update.status_code == 200
    assert (await client.post(base + "/adjustments", json=key, headers=headers)).status_code in (
        401,
        403,
    )
    login = (
        await client.post(
            "/api/auth/login",
            json={"identifier": username, "password": password, "clientType": "native"},
        )
    ).json()
    restricted = {"Authorization": "Bearer " + login["accessToken"]}
    assert (
        await client.post(base + "/adjustments", json=key, headers=restricted)
    ).status_code == 403
    users = (await client.get("/api/admin/users", headers=restricted)).json()
    assert users["users"] and all("billing" not in u for u in users["users"])
    assert (await client.get("/api/me/billing")).json()["availablePoints"] == 0


@pytest.mark.parametrize("platform_configuration", ["03df95c8ec04"], indirect=True)
async def test_upgrade_manual_billing(platform_configuration: Settings) -> None:
    url = platform_configuration.database_url
    engine = create_async_engine(url)
    try:
        async with engine.begin() as db:
            for role in ["admin", "clerical"]:
                await db.execute(
                    insert(RoleRow).values(
                        id=role,
                        name=role,
                        description="",
                        permissions=["users.read"],
                        builtin=role == "admin",
                        revision=2,
                    )
                )
            group = dict(
                id="billing.subscriptions",
                kind="group",
                moduleId=None,
                parentId=None,
                title="自定义",
                icon="user",
                order=0,
                visible=True,
                roleIds=["clerical"],
            )
            item = dict(
                id="access.users",
                kind="page",
                moduleId="access.users",
                parentId=group["id"],
                title="自选入口",
                icon="user",
                order=10000,
                visible=False,
                roleIds=["clerical"],
            )
            for key in ["global", "entertainment"]:
                await db.execute(
                    insert(NavigationRow).values(id=key, version=6, items=[group, item])
                )
        await upgrade_database(url)
        async with engine.begin() as db:
            assert (
                await db.scalar(select(RoleRow.permissions).where(RoleRow.id == "clerical"))
            ) == ["users.read"]
            admin = await db.scalar(select(RoleRow.permissions).where(RoleRow.id == "admin"))
            assert admin and set(admin) == {
                "billing.plans.manage",
                "billing.rates.manage",
                "users.read",
                "billing.read",
                "billing.subscriptions.manage",
                "billing.adjustments.create",
                "billing.receipts.record",
            }
            for version, items in await db.execute(
                select(NavigationRow.version, NavigationRow.items)
            ):
                assert items[5]["moduleId"] == "billing.cards" and not items[5]["visible"]
                assert items[5]["roleIds"] == ["clerical"]
                assert version == 10 and items[2]["moduleId"] == "billing.subscriptions"
                assert (
                    items[4]["moduleId"] == "billing.rates"
                    and items[4]["parentId"] == items[3]["parentId"]
                )
                assert items[3]["moduleId"] == "billing.plans"
                assert items[3]["parentId"] == items[2]["parentId"]
                assert not items[3]["visible"] and items[3]["roleIds"] == ["clerical"]
                assert items[1]["parentId"] == items[0]["id"] == items[2]["parentId"]
                assert not items[2]["visible"] and items[2]["roleIds"] == ["clerical"]
    finally:
        await engine.dispose()
