"""真实数据库验证声明式默认资源和示例包的初始化、撤销与失败补偿。"""

import copy
from dataclasses import replace

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.infrastructure.errors import DomainError


async def test_examples_are_editable_idempotent_and_do_not_restore_deleted(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """真实资料、知识库及四个组合一次导入；删除后不因页面刷新重建。"""
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    response = await client.post("/api/admin/agents/initialize")
    assert response.status_code == 200, response.text
    result = response.json()
    assert (
        len(result["agents"]) == 4
        and len(result["assets"]) == 4
        and len(result["knowledgeBases"]) == 3
    )
    assert {asset["kind"] for asset in result["assets"]} == {
        "knowledge",
        "spreadsheet-template",
        "presentation-template",
    }
    assert (await client.post("/api/admin/agents/initialize")).json() == result
    deleted = result["agents"][0]["id"]
    assert (await client.delete("/api/admin/agents/" + deleted)).status_code == 200
    again = (await client.post("/api/admin/agents/initialize")).json()
    assert deleted not in [item["id"] for item in again["agents"]]
    copied = await client.post("/api/admin/agents/initialize", json={"copyLatest": True})
    assert copied.status_code == 200, copied.text
    assert len(copied.json()["agents"]) == 4
    assert deleted not in [item["id"] for item in copied.json()["agents"]]
    assert len(await app.state.services.agents.assets.list(account)) == 4
    with pytest.raises(DomainError) as denied:
        await app.state.services.agents.initialize(replace(account, permissions=("sessions.run",)))
    assert denied.value.status == 403


async def test_invalid_package_rolls_back_resources_and_generated_assets(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """配置校验失败不能留下部分智能体或新生成的示例资料。"""
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    examples = app.state.services.agents.examples
    examples.package = copy.deepcopy(examples.package)
    examples.package["resources"][-1]["toolIds"] = ["missing-tool"]
    response = await client.post("/api/admin/agents/initialize")
    assert response.status_code in {404, 422}, response.text
    assert await app.state.services.agents.assets.list(account) == []
    assert not (await app.state.services.resources.package_status(account, examples.package))[
        "initialized"
    ]
