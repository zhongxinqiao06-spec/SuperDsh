"""五类预置角色通过真实登录与独立数据库验证，成员操作不能变更另一产品授权。"""

from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.identity.entity.bo.models import PERMISSIONS
from app.modules.identity.entity.bo.product_roles import builtin_grants


async def test_product_roles_login_and_membership_boundaries(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    superuser = await bootstrap(client)
    registered = (await client.get("/api/admin/roles")).json()["roles"]
    assert {r["id"]: r["name"] for r in registered} == {
        "admin": "平台超级管理员",
        "member": "办公用户",
        "office_admin": "办公管理员",
        "entertainment_admin": "娱乐管理员",
        "entertainment_creator": "娱乐创作者",
    }
    grants = builtin_grants(PERMISSIONS)
    for role in registered:
        assert role["builtin"] and set(role["permissions"]) == set(grants[role["id"]])
    assert "terminal.use" not in grants["entertainment_creator"]
    password = "Synthetic-product-role!"

    async def create(name: str, *roles: str) -> dict:
        row = await client.post(
            "/api/admin/users",
            json={
                "username": name,
                "displayName": name,
                "roles": list(roles),
                "password": password,
            },
        )
        assert row.status_code == 201, row.text
        return await complete_initial_login(client, name, password)

    accounts = {"admin": superuser}
    for role_id in ["member", "office_admin", "entertainment_admin", "entertainment_creator"]:
        accounts[role_id] = await create("test-" + role_id, role_id)
    dual = await create("test-mixed", "office_admin", "entertainment_creator")

    def headers(account: dict) -> dict[str, str]:
        return {"Authorization": "Bearer " + str(account["accessToken"])}

    for role_id, account in accounts.items():
        h = headers(account)
        wallet = (await client.get("/api/me/billing", headers=h)).json()
        assert wallet["unlimited"] == (role_id in {"admin", "office_admin", "entertainment_admin"})
        assert (await client.get("/api/auth/me", headers=h)).json()["roles"] == [role_id]
        for product in ["office", "entertainment"]:
            allowed = role_id in ["admin", product + "_admin"]
            response = await client.get("/api/products/" + product + "/members", headers=h)
            assert response.status_code == (200 if allowed else 403), response.text
            if role_id == "admin":
                assert all(
                    row["billing"]["userId"] == row["userId"] for row in response.json()["items"]
                )
            elif allowed:
                assert all("billing" not in row for row in response.json()["items"])
        for path in ["/api/admin/users", "/api/admin/roles"]:
            assert (await client.get(path, headers=h)).status_code == (
                200 if role_id == "admin" else 403
            )

    office = "/api/products/office/members"
    entertainment = "/api/products/entertainment/members"
    scopes = headers(dual)
    assert (await client.get(office, headers=scopes)).status_code == 200
    for method in ["get", "post", "delete"]:
        if method == "post":
            result = await client.post(
                entertainment, headers=scopes, json={"identifier": "test-member"}
            )
        elif method == "delete":
            result = await client.delete(
                entertainment + "/" + str(accounts["entertainment_creator"]["userId"]),
                params={"revision": 1},
                headers=scopes,
            )
        else:
            result = await client.get(entertainment, headers=scopes)
        assert result.status_code == 403
    assert (
        await client.post(
            office, headers=scopes, json={"identifier": "test-member", "roles": ["admin"]}
        )
    ).status_code == 422
    assert (
        await client.patch(
            "/api/admin/users/" + str(dual["userId"]), headers=scopes, json={"roles": ["admin"]}
        )
    ).status_code == 403
    listing = (
        await client.get(office, headers=scopes, params={"search": "test-", "pageSize": 1})
    ).json()
    assert listing["total"] == 3 and len(listing["items"]) == 1
    listed = (await client.get(office, headers=scopes)).json()["items"]
    assert next(item for item in listed if item["userId"] == dual["userId"])["roleIds"] == [
        "office_admin"
    ]
    for item in listed:
        assert set(item) == {
            "userId",
            "username",
            "displayName",
            "roleIds",
            "removable",
            "revision",
        }
        if item["roleIds"] != ["member"]:
            assert not item["removable"]
            assert (
                await client.delete(
                    office + "/" + item["userId"],
                    headers=scopes,
                    params={"revision": item["revision"]},
                )
            ).status_code == 403
    creator = accounts["entertainment_creator"]
    target = office + "/" + str(creator["userId"])
    assert (
        await client.get(office, headers=scopes, params={"search": "entertainment_creator"})
    ).json()["total"] == 0
    assert (await client.delete(target, headers=scopes, params={"revision": 1})).status_code == 404
    added = await client.post(office, headers=scopes, json={"identifier": creator["username"]})
    assert added.status_code == 200 and added.json()["roleIds"] == ["member"]
    version = added.json()["revision"]
    again = await client.post(office, headers=scopes, json={"identifier": creator["username"]})
    assert again.json() == added.json()
    assert (await client.get("/api/auth/me", headers=headers(creator))).status_code == 401
    assert (
        await client.delete(target, headers=scopes, params={"revision": version - 1})
    ).status_code == 409
    assert (
        await client.delete(target, headers=scopes, params={"revision": version})
    ).status_code == 204
    renewed = (
        await client.post(
            "/api/auth/login", json={"identifier": creator["username"], "password": password}
        )
    ).json()
    assert renewed["roles"] == ["entertainment_creator"]
    assert (await client.get("/api/studio/projects", headers=headers(renewed))).status_code == 200
    actor = await app.state.services.identity.authenticate(str(dual["accessToken"]))
    assert {r["id"] for r in await app.state.services.identity.role_choices(actor, "office")} == {
        "member",
        "office_admin",
    }
    assert set(
        await app.state.services.identity.menu_role_permissions(actor, "office", "member")
    ) == set(grants["member"])
    # 旧系统可存在持有全局操作码的自定义角色，仍禁止借分配权限变相成为超管。
    delegated = await client.post(
        "/api/admin/roles", json={"name": "合成委派角色", "permissions": grants["admin"]}
    )
    maintainer = await create("legacy-maintainer", delegated.json()["id"])
    legacy = headers(maintainer)
    neutral = accounts["member"]
    for operation in (
        await client.patch(
            "/api/admin/users/" + str(neutral["userId"]), headers=legacy, json={"disabled": True}
        ),
        await client.patch(
            "/api/admin/users/" + str(neutral["userId"]),
            headers=legacy,
            json={"roles": ["office_admin"]},
        ),
        await client.post(
            "/api/admin/roles",
            headers=legacy,
            json={"name": "越权委派", "permissions": ["products.office", "products.entertainment"]},
        ),
    ):
        assert operation.status_code == 403, operation.text
