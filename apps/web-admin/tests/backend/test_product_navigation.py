"""在隔离 PostgreSQL 上验证按产品授权的菜单、编辑和旧客户端兼容。"""

import asyncio
from copy import deepcopy

from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.navigation.entity.do.models import NavigationRow


async def test_product_menu_access_and_independent_revisions(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)

    async def user(name: str, roles: list[str]) -> dict[str, str]:
        password = "Synthetic-test-password!"
        reply = await client.post(
            "/api/admin/users",
            json={
                "username": name,
                "displayName": name,
                "password": password,
                "roles": roles,
            },
        )
        assert reply.status_code == 201, reply.text
        login = await complete_initial_login(client, name, password)
        return {"Authorization": "Bearer " + str(login["accessToken"])}

    role = (
        await client.post(
            "/api/admin/roles",
            json={
                "name": "制作成员",
                "permissions": [
                    "products.entertainment",
                    "studio.projects.read",
                    "studio.assets.read",
                ],
            },
        )
    ).json()["id"]
    reader = await user("studioeditor", [role])
    manager_role = (
        await client.post(
            "/api/admin/roles",
            json={
                "name": "菜单维护",
                "permissions": [
                    "menus.manage",
                    "studio.projects.read",
                    "studio.assets.read",
                ],
            },
        )
    ).json()["id"]
    manager = await user("menumanager", [manager_role])
    assert (await client.get("/api/navigation?product=office", headers=reader)).status_code == 403
    assert (
        await client.get("/api/navigation?product=entertainment", headers=manager)
    ).status_code == 403
    assert (await client.get("/api/navigation?product=invalid")).status_code == 422
    assert (
        await client.get("/api/admin/menus?product=entertainment", headers=reader)
    ).status_code == 403
    compat = (await client.get("/api/v2/navigation", headers=manager)).json()["items"]
    assert "account.profile" in {i["id"] for i in compat}
    assert not ({"workbench", "studio.projects"} & {i["id"] for i in compat})

    menus = "/api/admin/menus"
    office = (await client.get(menus)).json()
    modules = {m["id"] for m in office["modules"]}
    assert {
        "workbench",
        "office.history",
        "office.devices",
        "product.members",
        "product.defaults",
    } <= modules
    assert "studio.projects" not in modules
    for item in office["items"]:
        if item["id"] == "workbench":
            item["title"] = "原办公自定义"
    office_saved = await client.put(
        menus, json={"items": office["items"], "version": office["version"]}
    )
    assert office_saved.status_code == 200
    office = office_saved.json()
    # 模拟旧部署只有 global 行，升级时恢复娱乐初始目录，保留既有办公配置。
    async with app.state.database.sessions.begin() as session:
        existing = await session.get(NavigationRow, "entertainment")
        assert existing is not None
        await session.delete(existing)
    await app.state.services.navigation.initialize()
    studio = (await client.get(menus, params={"product": "entertainment"}, headers=manager)).json()
    draft = deepcopy(studio["items"])
    for item in draft:
        if item["id"] == "studio.tasks":
            item["roleIds"] = ["admin"]
        if item["id"] == "studio.projects":
            item.update(title="我的片单", order=2)
        if item["id"] == "studio.library":
            item["order"] = 0
    body = {"items": draft, "version": studio["version"]}
    edit = await client.put(menus + "?product=entertainment", json=body, headers=manager)
    assert edit.status_code == 200, edit.text
    assert (
        await client.put(menus + "?product=entertainment", json=body, headers=manager)
    ).status_code == 409
    await app.state.services.navigation.initialize()
    personal = (await client.get("/api/navigation?product=entertainment", headers=reader)).json()
    pages = [i for i in personal["items"] if i["id"].startswith("studio.")]
    assert {i["id"] for i in pages} == {
        "studio.library",
        "studio.projects",
        "studio.characters",
        "studio.environments",
        "studio.props",
        "studio.deliveries",
    }
    assert next(i for i in pages if i["id"] == "studio.projects")["title"] == "我的片单"
    assert "workbench" not in {i["id"] for i in personal["items"]}
    assert (await client.get(menus + "?product=office")).json() == office
    illegal = deepcopy(draft)
    next(i for i in illegal if i["id"] == "models")["visible"] = False
    assert (
        await client.put(
            menus + "?product=entertainment",
            headers=manager,
            json={"items": illegal, "version": personal["version"]},
        )
    ).status_code == 403
    responses = await asyncio.gather(
        *(
            client.post(
                menus + "/reset?product=entertainment",
                json={"version": personal["version"]},
            )
            for _ in range(2)
        )
    )
    assert sorted(r.status_code for r in responses) == [200, 409]
    restored = (await client.get("/api/navigation?product=entertainment", headers=reader)).json()
    assert {i["id"] for i in restored["items"] if i["id"].startswith("studio.")} == {
        "studio.projects",
        "studio.library",
        "studio.tasks",
        "studio.characters",
        "studio.environments",
        "studio.props",
        "studio.deliveries",
    }
    assert (await client.get(menus)).json() == office


async def test_product_menu_editor_cannot_change_platform(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client)
    password = "Synthetic-office-password!"
    read_role = await client.post(
        "/api/admin/roles",
        json={"name": "只读菜单观察员", "permissions": ["menus.read"]},
    )
    assert read_role.status_code == 201
    assert (
        await client.post(
            "/api/admin/users",
            json={
                "username": "mixededitor",
                "displayName": "组合菜单管理员",
                "password": password,
                "roles": [
                    "office_admin",
                    "entertainment_creator",
                    read_role.json()["id"],
                ],
            },
        )
    ).status_code == 201
    account = await complete_initial_login(client, "mixededitor", password)
    headers = {"Authorization": "Bearer " + str(account["accessToken"])}
    menus = "/api/admin/menus?product=office"
    original = (await client.get(menus)).json()
    next(i for i in original["items"] if i["id"] == "platform")["title"] = "平台自定义"
    saved = await client.put(
        menus, json={"version": original["version"], "items": original["items"]}
    )
    assert saved.status_code == 200
    editable = (await client.get(menus, headers=headers)).json()
    assert set(editable["editableIds"]) == {i["id"] for i in editable["items"]}
    assert {"models", "platform", "access.users"}.isdisjoint(editable["editableIds"])

    async def save(items: list[dict[str, object]]) -> int:
        return (
            await client.put(
                menus,
                headers=headers,
                json={"version": editable["version"], "items": items},
            )
        ).status_code

    for key, value, expected in [
        ("parentId", "platform", 403),
        ("id", "models", 403),
        ("id", [], 422),
    ]:
        patch = deepcopy(editable["items"])
        next(i for i in patch if i["id"] == "agents")[key] = value
        assert await save(patch) == expected
    next(i for i in editable["items"] if i["id"] == "skills")["title"] = "办公技能"
    assert await save(editable["items"]) == 200
    preview = await client.get(
        "/api/admin/menus/preview?product=office&roleId=member", headers=headers
    )
    assert preview.status_code == 200
    assert "agents" not in {i["id"] for i in preview.json()["items"]}
    assert (
        await client.post(
            "/api/admin/menus/reset?product=office",
            headers=headers,
            json={"version": editable["version"] + 1},
        )
    ).status_code == 200
    items = {i["id"]: i for i in (await client.get(menus)).json()["items"]}
    assert items["platform"]["title"] == "平台自定义"
    assert items["skills"]["title"] == "技能"
    # 超管可引用历史角色 ID；在娱乐端展示时只匹配这个账号的娱乐角色。
    studio_menus = "/api/admin/menus?product=entertainment"
    studio = (await client.get(studio_menus)).json()
    next(i for i in studio["items"] if i["id"] == "studio.library")["roleIds"] = ["office_admin"]
    next(i for i in studio["items"] if i["id"] == "studio.tasks")["roleIds"] = [
        "entertainment_creator"
    ]
    assert (
        await client.put(
            studio_menus, json={"version": studio["version"], "items": studio["items"]}
        )
    ).status_code == 200
    visible = (await client.get("/api/navigation?product=entertainment", headers=headers)).json()[
        "items"
    ]
    assert "studio.library" not in {item["id"] for item in visible}
    assert "studio.tasks" in {item["id"] for item in visible}
    endpoint = "/api/admin/menus/preview?product=office&roleId=entertainment_creator"
    other_product = await client.get(endpoint)
    assert other_product.status_code == 200 and other_product.json()["items"] == []
    # 组合账号的显式全局只读权限允许预览，但不会使其娱乐菜单可写。
    assert (await client.get(endpoint, headers=headers)).json()["items"] == []
    assert (
        await client.post(
            "/api/admin/menus/reset?product=entertainment",
            headers=headers,
            json={"version": studio["version"] + 1},
        )
    ).status_code == 403
