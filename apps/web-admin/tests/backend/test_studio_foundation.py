"""第一阶段真实数据库验收：规格、幂等、结构化保存、版本隔离与五角色边界。"""

import asyncio
from copy import deepcopy

from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text


async def test_foundation_workflow(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    await bootstrap(client)
    root = "/api/studio/projects"
    defaults = (await client.get("/api/studio/creation-defaults")).json()
    brief = {
        key: defaults[key]
        for key in ("aspectWidth", "aspectHeight", "targetDurationMs", "language")
    }
    body = {
        **brief,
        "title": "雨后站台",
        "brief": "两人重逢",
        "styleBrief": "写实雨夜",
        "requestKey": "new-film",
    }
    created = await asyncio.gather(*(client.post(root, json=body) for _ in range(2)))
    assert all(r.status_code == 200 for r in created), [r.text for r in created]
    assert created[0].json()["id"] == created[1].json()["id"]
    project = created[0].json()["id"]
    path = root + "/" + project
    assert (await client.post(root, json={**body, "title": "不能同号换内容"})).status_code == 409
    role = (
        await client.post(
            "/api/studio/assets",
            json={
                "kind": "character",
                "name": "小林",
                "voice": "voice-a",
                "description": "蓝外套",
            },
        )
    ).json()["id"]
    original_scenes = [
        {"id": "platform", "title": "外景·站台·夜", "synopsis": "雨中重逢"},
        {"id": "home", "title": "家", "synopsis": "尚未分镜"},
    ]
    document = {
        "script": "站台。小林说：等到了。",
        "adaptationMode": "original",
        "assets": [role],
        "musicVolume": 0.6,
        "scenes": original_scenes,
        "shots": [
            {
                "id": "shot-a",
                "action": "雨夜",
                "sceneId": "platform",
                "references": [role],
                "duration": 5000,
                "trimStart": 400,
                "trimEnd": 4200,
                "lines": [
                    {
                        "id": "line-a",
                        "text": "等到了",
                        "role": role,
                        "start": 7000,
                        "volume": 0.8,
                    }
                ],
            }
        ],
    }
    request = {"revision": 1, "document": document, "requestKey": "save-draft"}
    replies = await asyncio.gather(*(client.put(path, json=request) for _ in range(2)))
    assert all(r.status_code == 200 for r in replies), [r.text for r in replies]
    assert replies[0].json() == replies[1].json()
    assert (await client.put(path, json={**request, "label": "换内容"})).status_code == 409
    opened = (await client.get(path)).json()
    assert opened["revision"] == 2 and opened["aspectWidth"] == brief["aspectWidth"]
    current = opened["document"]
    assert current["scenes"] == [
        {**scene, "scriptRange": None, "sceneAssetId": None} for scene in original_scenes
    ]
    assert current["musicVolume"] == 0.6
    assert current["shots"][0]["lines"][0]["start"] == 7000
    assert current["assets"] != [role]
    chosen = next(a for a in opened["assets"] if a["id"] == current["assets"][0])
    assert chosen["parent"] == role and chosen["project"] == project
    changed = deepcopy(current)
    changed["shots"][0]["lines"][0]["subtitle"] = "只改字幕"
    changed["scenes"].reverse()
    assert (
        await client.put(path, json={"revision": 2, "document": changed, "requestKey": "reorder"})
    ).status_code == 200
    assert (
        await client.put(path, json={"revision": 2, "document": current, "requestKey": "stale"})
    ).status_code == 409
    # 当前关系行和不可变修订同事务提交；没有镜头的场次也持久保存。
    async with app.state.database.sessions() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT id,position FROM studio_story_scenes WHERE project_id=:id AND archived_at IS NULL ORDER BY position"
                ),
                {"id": project},
            )
        ).all()
        assert [row.id for row in rows] == ["home", "platform"]
        assert (
            await session.scalar(
                text("SELECT count(*) FROM studio_project_snapshots WHERE project_id=:id"),
                {"id": project},
            )
            == 3
        )
    archive = {"revision": 3, "requestKey": "archive", "archived": True}
    assert (await client.post(path + "/archive", json=archive)).status_code == 200
    assert (await client.post(path + "/archive", json=archive)).json()["revision"] == 4
    assert (await client.get(root, params={"page": 1})).json()["total"] == 0
    assert (await client.get(root, params={"page": 1, "lifecycle": "archived"})).json()[
        "total"
    ] == 1
    assert (await client.put(path, json={"revision": 4, "document": current})).status_code == 409
    assert (
        await client.post(
            path + "/archive",
            json={"revision": 4, "requestKey": "restore", "archived": False},
        )
    ).status_code == 200
    assert (
        await client.patch(
            path, json={**body, "requestKey": "brief", "revision": 5, "title": "重逢"}
        )
    ).status_code == 200
    assert (await client.get(path)).json()["document"] == changed
    restored = await client.post(path + "/revisions/2/restore", params={"revision": 6})
    assert restored.status_code == 200, restored.text
    assert (await client.get(path)).json()["title"] == "雨后站台"
    for category, expected in (("characters", 1), ("environments", 0), ("media", 0)):
        reply = await client.get("/api/studio/library", params={"category": category})
        assert reply.json()["total"] == expected


async def test_five_roles_and_combined_product_access(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client)
    pages = {
        "studio.projects",
        "studio.tasks",
        "studio.deliveries",
        "studio.characters",
        "studio.environments",
        "studio.props",
        "studio.library",
    }
    profiles = [
        (["admin"], True),
        (["office_admin"], False),
        (["entertainment_admin"], True),
        (["member"], False),
        (["entertainment_creator"], True),
        (["office_admin", "entertainment_creator"], True),
    ]
    projects: list[str] = []
    for index, (roles, allowed) in enumerate(profiles):
        name = "foundation-user-" + str(index)
        password = "Synthetic-password-123!"
        response = await client.post(
            "/api/admin/users",
            json={
                "username": name,
                "displayName": name,
                "password": password,
                "roles": roles,
            },
        )
        assert response.status_code == 201, response.text
        login = await complete_initial_login(client, name, password)
        headers = {"Authorization": "Bearer " + str(login["accessToken"])}
        navigation = await client.get("/api/navigation?product=entertainment", headers=headers)
        assert navigation.status_code == (200 if allowed else 403)
        if allowed:
            assert pages <= {item["moduleId"] for item in navigation.json()["items"]}
        created = await client.post(
            "/api/studio/projects",
            headers=headers,
            json={"title": name, "requestKey": "new-project"},
        )
        assert created.status_code == (200 if allowed else 403), created.text
        if allowed:
            if projects:
                assert (
                    await client.get("/api/studio/projects/" + projects[0], headers=headers)
                ).status_code == 404
            projects.append(created.json()["id"])
        if len(roles) == 2:
            for product in ("office", "entertainment", "office", "entertainment"):
                assert (
                    await client.get(
                        "/api/navigation", params={"product": product}, headers=headers
                    )
                ).status_code == 200
            assert (
                await client.get("/api/admin/menus?product=office", headers=headers)
            ).status_code == 200
            assert (
                await client.get("/api/admin/menus?product=entertainment", headers=headers)
            ).status_code == 403
            assert (await client.get("/api/admin/users", headers=headers)).status_code == 403
