"""预置工具更新显式恢复：旧摘要仍拒绝执行，用户配置与会话身份保持不变。"""

from copy import deepcopy
from dataclasses import replace

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.infrastructure.errors import DomainError
from app.modules.extensions.service.validation import digest
from app.modules.identity.entity.bo.models import Account


async def setup(platform: tuple[FastAPI, AsyncClient]) -> tuple[Account, dict[str, str], str]:
    app, client = platform
    auth = await bootstrap(client)
    account = await app.state.services.identity.authenticate(auth["accessToken"])
    created = await client.post("/api/studio/projects", json={"title": "预置工具更新验证"})
    assert created.status_code == 200, created.text
    ids = await app.state.services.resources.initialize_product(
        account, app.state.services.studio_agent.package
    )
    return account, ids, "/api/studio/projects/" + created.json()["id"]


def change_builtin(app: FastAPI) -> tuple[str, str]:
    """模拟开发更新已发布的 Schema；故障必须仍由真实摘要校验触发。"""
    extension = app.state.services.extensions
    manifest = deepcopy(extension.builtins["starbridge.studio"])
    old_digest = digest(manifest["tools"])
    manifest["tools"][0]["description"] += "（新版说明）"
    extension.builtins[manifest["id"]] = manifest
    return old_digest, digest(manifest["tools"])


async def test_refresh_unblocks_first_director_and_preserves_customization(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    account, ids, path = await setup(platform)
    resources = app.state.services.resources
    tool_id = next(value for key, value in ids.items() if key != "director")
    tool = await resources.get(account, "tool", tool_id)
    tool = await resources.save(account, "tool", {**tool, "name": "我的工具别名"}, tool_id)
    baseline = (await client.get(path)).json()
    old_digest, current_digest = change_builtin(app)
    failed = await client.post(path + "/conversation")
    assert failed.status_code == 409 and failed.json()["code"] == "tool_implementation_changed"
    # 没有代理会话、没有剧本写入；恢复不是绕过失败直接发送任务。
    assert (await client.get(path)).json() == baseline
    response = await client.post(
        path + "/conversation/refresh", params={"agentDefinitionId": ids["director"]}
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["updatedTools"] == len(ids) - 1 and result["agentId"] == ids["director"]
    assert (await client.post(path + "/conversation")).json()["sessionId"] == result["sessionId"]
    refreshed = await resources.get(account, "tool", tool_id)
    assert refreshed["name"] == "我的工具别名" and refreshed["version"] == tool["version"] + 1
    assert refreshed["implementation"]["digest"] == current_digest
    assert refreshed["settings"] == tool["settings"]
    assert (await client.get(path)).json()["document"] == baseline["document"]
    async with resources.repository.transaction() as tx:
        history = await tx.snapshot(tool_id, tool["version"])
        assert history["implementation"]["digest"] == old_digest
    with pytest.raises(DomainError) as failure:
        await app.state.services.extensions.bind(account, tool["implementation"])
    assert failure.value.code == "tool_implementation_changed"


async def test_refresh_existing_session_permission_disabled_and_custom_guard(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    account, ids, path = await setup(platform)
    project_id = path.rsplit("/", 1)[-1]
    created = await client.post(path + "/conversation")
    session_id = created.json()["sessionId"]
    frozen = await app.state.services.resources.bind(account, session_id, ids["director"])
    await app.state.services.conversations.attach_binding(
        account, session_id, {"bindingId": frozen.id}, 1
    )
    previous = await app.state.services.conversations.binding(account, session_id)
    change_builtin(app)
    service = app.state.services.studio_agent
    with pytest.raises(DomainError) as failure:
        await service.refresh_conversation(replace(account, user_id="other-user"), project_id)
    assert failure.value.status == 404
    with pytest.raises(DomainError) as failure:
        await service.refresh_conversation(replace(account, permissions=()), project_id)
    assert failure.value.status == 403
    rejected = await client.post(
        path + "/conversation/refresh", params={"agentDefinitionId": "custom-agent"}
    )
    assert rejected.status_code == 409
    # 运行中不能换绑定；公开更新工具操作不会假装取消了 DSH 中正在执行的任务。
    async with app.state.services.conversations.repository.transaction() as dao:
        row = await dao.session(session_id)
        row.status = "running"
        await dao.save(row)
    assert (await client.post(path + "/conversation/refresh")).status_code == 409
    async with app.state.services.conversations.repository.transaction() as dao:
        row = await dao.session(session_id)
        row.status = "idle"
        await dao.save(row)
    # 创作者不需要获得管理所有工具的权限，只能刷新本人可信预置工具。
    creator = replace(
        account, permissions=tuple(p for p in account.permissions if p != "agents.manage")
    )
    response = await service.refresh_conversation(creator, project_id)
    assert response["sessionId"] == session_id
    current = await app.state.services.conversations.binding(account, session_id)
    assert current["bindingVersion"] == previous["bindingVersion"] + 1
    assert "bindingId" not in current
    async with app.state.services.resources.repository.transaction() as tx:
        old_binding = await tx.binding(frozen.id)
        assert old_binding.snapshots == frozen.snapshots
    tool_id = next(value for key, value in ids.items() if key != "director")
    resources = app.state.services.resources
    tool = await resources.get(account, "tool", tool_id)
    await resources.save(account, "tool", {**tool, "enabled": False}, tool_id)
    change_builtin(app)
    denied = await client.post(path + "/conversation/refresh")
    assert denied.status_code == 409
    assert (await resources.get(account, "tool", tool_id))["enabled"] is False
    assert await app.state.services.conversations.binding(account, session_id) == current
