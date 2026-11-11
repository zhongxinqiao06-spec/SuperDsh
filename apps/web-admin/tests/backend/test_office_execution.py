"""可配置办公实现经通用确认/收据/文件服务发布真实成果，不伪造技能或执行引擎。"""

import hashlib
import io
import json
from dataclasses import replace
from typing import cast

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.vo.conversation_dto import CreateSessionInput


async def test_configured_illustration_confirmation_artifact_revision_and_revocation(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """真实工作进程与真实PG：确认前无产物，重试收据复用，修订保留旧文件，撤权拒绝读取。"""
    app, client = platform
    services = app.state.services
    login = await bootstrap(client)
    account = await services.identity.authenticate(str(login["accessToken"]))
    device = (await client.post("/api/connectors", json={"name": "合成会话容器"})).json()[
        "connector"
    ]
    # 此用例验证工具确认/成果，直接准备合成会话；HTTP导入另有完整协议回归。
    response = await services.conversations.create(
        account,
        CreateSessionInput(connectorId=device["id"], clientMessageId="office-test-session"),
        False,
    )
    session_id = response["session"]["id"]
    tool = next(
        item
        for item in await services.resources.catalog(account, "tool")
        if item.get("logicalId") == "illustration_render"
    )
    agent = await services.resources.save(
        account,
        "agent",
        {
            "name": "任意名称的组合",
            "instructions": "按确认后的结构生成配图",
            "toolIds": [tool["id"]],
            "skillIds": [],
            "published": True,
        },
    )
    binding = await services.resources.bind(account, session_id, agent["id"])
    frozen = next(item for item in binding.snapshots if item["id"] == tool["id"])
    execution = services.agent_execution.tools
    plan = {
        "title": "交付流程",
        "layout": "flow",
        "nodes": [{"id": "prepare", "title": "准备"}, {"id": "deliver", "title": "交付"}],
    }
    arguments = {"action": "plan", "planJson": json.dumps(plan)}
    waiting = await execution.invoke(account, binding, frozen, "illustration-first", arguments, {})
    assert "confirmation" in waiting
    assert not (services.evidence.object_root / account.user_id).exists()
    trusted = {"phase": "confirm-execute", "confirmation": waiting["confirmation"]}
    result = await execution.invoke(account, binding, frozen, "illustration-first", {}, trusted)
    assert "_pendingArtifacts" not in result and len(result["artifacts"]) == 1
    artifact = result["artifacts"][0]
    content, _ = await services.files.read(account, artifact["fileId"])
    with Image.open(io.BytesIO(content)) as image:
        assert image.size == (1600, 900) and image.format == "PNG"
    row, original_path = await services.evidence.resolve_artifact(account, artifact["id"])
    assert row.sha256 == hashlib.sha256(content).hexdigest() and row.run_id is None
    assert (
        await execution.invoke(account, binding, frozen, "illustration-first", {}, trusted)
        == result
    )
    changed = {**plan, "title": "修订后的交付流程"}
    revision = await execution.invoke(
        account,
        binding,
        frozen,
        "illustration-revision",
        {"action": "plan", "planJson": json.dumps(changed), "previousArtifactId": artifact["id"]},
        {},
    )
    revised = await execution.invoke(
        account,
        binding,
        frozen,
        "illustration-revision",
        {},
        {"phase": "confirm-execute", "confirmation": revision["confirmation"]},
    )
    second, _ = await services.evidence.resolve_artifact(account, revised["artifacts"][0]["id"])
    assert second.metadata_json["previousArtifactId"] == artifact["id"]
    assert original_path.read_bytes() == content
    with pytest.raises(DomainError):
        await services.evidence.resolve_artifact(
            replace(account, user_id="another-owner"), artifact["id"]
        )
    await services.resources.save(
        account, "tool", {**tool, "enabled": False}, cast(str, tool["id"])
    )
    with pytest.raises(DomainError):
        await services.evidence.resolve_artifact(account, artifact["id"])
