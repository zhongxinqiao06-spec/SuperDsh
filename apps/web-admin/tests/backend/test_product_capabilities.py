"""真实登录与数据库验证跨产品发布、共享引用、产品默认值和平台供应商隔离。"""

import base64

import pytest
from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient

from app.infrastructure.errors import DomainError


async def test_product_resources_and_effective_defaults(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)
    password = "Synthetic-role-ownership!"

    async def login(name: str, roles: list[str]) -> dict[str, str]:
        made = await client.post(
            "/api/admin/users",
            json={
                "username": name,
                "displayName": name,
                "roles": roles,
                "password": password,
            },
        )
        assert made.status_code == 201, made.text
        token = await complete_initial_login(client, name, password)
        return {"Authorization": "Bearer " + str(token["accessToken"])}

    mixed = await login("mixed-resource", ["office_admin", "entertainment_creator"])
    studio = await login("studio-manager", ["entertainment_admin"])
    other = await login("office-colleague", ["office_admin"])
    office = {"product": "office"}
    entertainment = {"product": "entertainment"}
    for path in ["agents", "skills", "tools", "tools/sources", "knowledge-bases"]:
        route = "/api/admin/" + path
        assert (await client.get(route, params=office, headers=mixed)).status_code == 200, path
        assert (await client.get(route, params=entertainment, headers=mixed)).status_code == 403, (
            path
        )
        assert (await client.get(route, headers=mixed)).status_code == 403, path
        assert (await client.get(route, params=entertainment, headers=studio)).status_code == 200, (
            path
        )
    for route in ["extensions", "models/configurations", "knowledge-embedding"]:
        assert (
            await client.get("/api/admin/" + route, params=office, headers=mixed)
        ).status_code == 403
    route = "/api/admin/knowledge-bases"
    doc = await client.post(route, params=office, headers=mixed, json={"name": "办公知识"})
    assert doc.status_code == 201, doc.text
    kb = doc.json()["knowledgeBase"]
    assert kb["product"] == "office"
    for body in [
        {"name": "forged", "product": "entertainment"},
        {"name": "forged", "product": "shared"},
    ]:
        assert (
            await client.post(route, params=office, headers=mixed, json=body)
        ).status_code == 403
    forbidden = await client.put(
        f"{route}/{kb['id']}",
        params=entertainment,
        headers=studio,
        json={"name": "forged", "version": 1},
    )
    assert forbidden.status_code == 404
    own = await client.put(
        f"{route}/{kb['id']}",
        params=office,
        headers=other,
        json={"name": "团队编辑", "version": 1},
    )
    assert own.status_code == 200, own.text
    assert (
        await client.get(f"{route}/{kb['id']}/versions", params=entertainment, headers=studio)
    ).status_code == 404
    assert (
        await client.post(
            f"{route}/{kb['id']}/restore",
            params=entertainment,
            headers=studio,
            json={"sourceVersion": 1, "version": 2},
        )
    ).status_code == 404
    shared = await client.post(route, params=office, json={"name": "平台共享", "product": "shared"})
    assert shared.status_code == 201, shared.text
    shared_id = shared.json()["knowledgeBase"]["id"]
    assert (
        await client.delete(f"{route}/{shared_id}", params=entertainment, headers=studio)
    ).status_code == 403
    agent_body = {
        "name": "工作助手",
        "instructions": "回答用户问题",
        "published": False,
        "knowledgeBaseIds": [shared_id],
    }
    for params, actor in [(office, mixed), (entertainment, studio)]:
        agent = await client.post(
            "/api/admin/agents", params=params, headers=actor, json=agent_body
        )
        assert agent.status_code == 201, agent.text
        assert agent.json()["agent"]["product"] == params["product"]
    forged = await client.post(
        "/api/resources/agents",
        params=entertainment,
        headers=studio,
        json={"name": "cross", "knowledgeBaseIds": [kb["id"]]},
    )
    assert forged.status_code in (404, 422)
    assert (await client.delete(f"{route}/{shared_id}", params=office)).status_code == 409

    # 跨账号实际发布和绑定，包括来自另一位产品管理员的文件与共享知识库。
    member = await login("office-reader", ["member"])
    sources = (await client.get("/api/admin/tools/sources", params=office, headers=mixed)).json()[
        "items"
    ]
    assert all("endpoint" not in source for source in sources)
    assert all(
        "products.entertainment" not in tool.get("permissions", [])
        for source in sources
        for tool in source["tools"]
    )
    source = next(
        item for item in sources if any(t["id"] == "knowledge_search" for t in item["tools"])
    )
    tool = await client.post(
        "/api/admin/tools",
        params=office,
        headers=other,
        json={
            "name": "办公检索",
            "implementation": {
                "sourceId": source["id"],
                "version": source["activeVersion"],
                "digest": next(
                    v["digest"]
                    for v in source["versions"]
                    if v["version"] == source["activeVersion"]
                ),
                "toolId": "knowledge_search",
            },
        },
    )
    assert tool.status_code == 201, tool.text
    tool_id = tool.json()["tool"]["id"]
    skill = await client.post(
        "/api/admin/skills",
        params=office,
        headers=mixed,
        json={
            "name": "证据检索技能",
            "instructions": "引用原文",
            "requiredToolIds": [tool_id],
        },
    )
    assert skill.status_code == 201, skill.text
    skill_id = skill.json()["skill"]["id"]
    raw = "合成办公资料".encode()
    file = await client.post(
        "/api/admin/agents/assets",
        params=office,
        headers=other,
        json={
            "kind": "knowledge",
            "name": "scope.txt",
            "contentBase64": base64.b64encode(raw).decode(),
        },
    )
    assert file.status_code == 201, file.text
    asset_id = file.json()["asset"]["id"]
    updated = await client.put(
        f"{route}/{kb['id']}",
        params=office,
        headers=mixed,
        json={"name": "团队知识", "version": 2, "assetIds": [asset_id]},
    )
    assert updated.status_code == 200, updated.text
    publish = await client.post(
        "/api/admin/agents",
        params=office,
        headers=mixed,
        json={
            **agent_body,
            "name": "发布带资源的办公智能体",
            "published": True,
            "knowledgeBaseIds": [kb["id"], shared_id],
            "toolIds": [tool_id],
            "skillIds": [skill_id],
        },
    )
    assert publish.status_code == 201, publish.text
    published_id = publish.json()["agent"]["id"]
    listed = (await client.get("/api/agents", headers=member)).json()["items"]
    assert published_id in {item["id"] for item in listed}
    listed_studio = (await client.get("/api/studio/catalog", headers=studio)).json()["agents"]
    assert published_id not in {item["id"] for item in listed_studio}
    services = app.state.services
    reader = await services.identity.authenticate(member["Authorization"].removeprefix("Bearer "))
    creator = await services.identity.authenticate(studio["Authorization"].removeprefix("Bearer "))
    binding = await services.resources.bind(reader, "isolated-session", published_id)
    assert {published_id, skill_id, tool_id, shared_id, kb["id"]} <= {
        item["id"] for item in binding.snapshots
    }
    assert all(item["version"] >= 1 for item in binding.snapshots)
    assert (await services.agents.assets.execution_content(reader, binding.id, asset_id))[0] == raw
    with pytest.raises(DomainError) as denied:
        await services.resources.bind(creator, "isolated-studio-session", published_id)
    assert denied.value.status == 403
    disabled = await client.put(
        "/api/admin/agents/" + published_id,
        params=office,
        headers=mixed,
        json={**agent_body, "version": 1, "published": False},
    )
    assert disabled.status_code == 200, disabled.text
    with pytest.raises(DomainError) as revoked:
        await services.resources.authorize_binding(reader, binding.id)
    assert revoked.value.status == 403

    base = "/api/admin/products/{}/model-defaults"
    assert (await client.get(base.format("entertainment"), headers=mixed)).status_code == 403
    conn = await client.post(
        "/api/admin/models/connections",
        json={
            "name": "synthetic",
            "adapter": "openai-completions",
            "baseUrl": "https://example.com",
            "apiKey": "synthetic-key",
        },
    )
    assert conn.status_code == 200, conn.text

    async def model(name: str, role_ids: list[str]) -> str:
        saved = await client.post(
            "/api/admin/models/configurations",
            json={
                "name": name,
                "capability": "chat",
                "modelId": name,
                "connectionId": conn.json()["id"],
                "roleIds": role_ids,
            },
        )
        assert saved.status_code == 200, saved.text
        return saved.json()["id"]

    a = await model("office-model", [])
    b = await model("studio-model", [])
    locked = await model("restricted-model", ["entertainment_admin"])
    office_only = await model("restricted-to-office-role", ["office_admin"])
    assert (await client.get("/api/studio/catalog", headers=mixed)).status_code == 200
    for product, expected in [("office", True), ("entertainment", False)]:
        catalog = (
            await client.get("/api/models/catalog", headers=mixed, params={"product": product})
        ).json()
        names = {m["modelId"] for provider in catalog["providers"] for m in provider["models"]}
        assert ("restricted-to-office-role" in names) == expected
        capabilities = (
            await client.get("/api/models/capabilities", headers=mixed, params={"product": product})
        ).json()
        assert (
            office_only in {entry["id"] for entry in capabilities["configurations"]}
        ) == expected
    for target, value, actor in [("office", a, mixed), ("entertainment", b, studio)]:
        result = await client.put(
            base.format(target) + "/chat",
            json={"configurationId": value},
            headers=actor,
        )
        assert result.status_code == 200, result.text
        catalog = (await client.get(base.format(target), headers=actor)).json()
        assert catalog["overrides"] == {"chat": value}
        assert "connections" not in catalog
    for target, value, expected_status in [("office", locked, 422), ("entertainment", a, 403)]:
        response = await client.put(
            base.format(target) + "/chat",
            json={"configurationId": value},
            headers=mixed,
        )
        assert response.status_code == expected_status, response.text
    projected = (await client.get("/api/models/catalog", headers=mixed)).json()
    assert projected["default"]["modelId"] == "office-model"
    assert projected["productDefaults"]["entertainment"]["modelId"] == "studio-model"
    studio_view = (await client.get("/api/studio/catalog", headers=mixed)).json()
    assert {"capability": "chat", "configurationId": b} in studio_view["defaults"]
    assert locked not in {entry["id"] for entry in studio_view["configurations"]}
    assert (
        await client.put(
            "/api/admin/models/defaults/chat",
            headers=mixed,
            json={"configurationId": a, "revision": 0},
        )
    ).status_code == 403
    assert (
        await client.put(
            base.format("office") + "/chat",
            headers=mixed,
            json={"configurationId": None},
        )
    ).status_code == 200
    assert (await client.get(base.format("office"), headers=mixed)).json()["overrides"] == {}
