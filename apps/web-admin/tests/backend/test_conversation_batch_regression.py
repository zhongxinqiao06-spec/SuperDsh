"""隔离实库种子验证批量接口；种子仅创建会话事实，不模拟执行或旧服务。"""

from datetime import UTC, datetime

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.conversations.entity.do.models import SessionRow
from app.modules.conversations.service.conversation_service import ConversationService


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_batch_read_and_full_scope_archive(
    platform: tuple[FastAPI, AsyncClient], prefix: str
) -> None:
    """103条项目会话与2条项目外会话验证无100条截断、取消归档及数组协议。"""
    app, client = platform
    account = await bootstrap(client, prefix)
    connector = (await client.post(prefix + "/connectors", json={"name": "批量合成设备"})).json()[
        "connector"
    ]["id"]
    project = (
        await client.post(
            prefix + "/projects",
            json={
                "connectorId": connector,
                "name": "批量合成项目",
                "workspacePath": "/synthetic/batch",
            },
        )
    ).json()["project"]["id"]
    conversations: ConversationService = app.state.services.conversations
    now = datetime.now(UTC)
    async with conversations.repository.transaction() as dao:
        for index in range(105):
            await dao.save(
                SessionRow(
                    id=f"batch-{index:03}",
                    owner_id=str(account["userId"]),
                    connector_id=connector,
                    project_id=project if index < 103 else None,
                    runtime_id="controlled",
                    runtime_type="controlled",
                    title="合成会话",
                    cwd="/synthetic/batch",
                    source={},
                    state={},
                    status="idle",
                    sequence=40,
                    latest_turn_end_seq=45,
                    last_read_seq=0,
                    archived=bool(index % 2),
                    pinned=False,
                    takeover=False,
                    created_at=now,
                    updated_at=now,
                )
            )
    invalid = await client.post(prefix + "/sessions/read", json={"sessionIds": ["batch-000"]})
    assert (
        invalid.status_code == 422
        and invalid.json()["detail"] == "expected an array of session IDs"
    )
    empty = await client.post(prefix + "/sessions/read", json=[])
    assert empty.status_code == 200 and empty.json()["affected"] == 0
    partial = await client.post(prefix + "/sessions/archive", json=["batch-000", "foreign-session"])
    assert partial.status_code == 404
    unchanged = (await client.get(prefix + "/sessions/batch-000/meta")).json()["session"]
    assert unchanged["archived"] is False and unchanged["updatedSeq"] == 40
    read = await client.post(prefix + "/sessions/read", json=["batch-000", "batch-104"])
    assert read.status_code == 200 and read.json()["affected"] == 2
    assert all(
        item["updatedSeq"] == 40 and item["lastReadSeq"] == 45 and item["unread"] is False
        for item in read.json()["sessions"]
    )
    archived = await client.post(
        f"{prefix}/projects/{project}/sessions/archive-all",
        json={"archived": True, "scope": "ignored"},
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["affected"] == 103 and len(archived.json()["sessions"]) == 103
    assert all(item["archived"] is True for item in archived.json()["sessions"])
    outside = (await client.get(prefix + "/sessions/batch-104/meta")).json()["session"]
    assert outside["archived"] is False and outside["updatedSeq"] == 40
    restored = await client.post(
        f"{prefix}/connectors/{connector}/sessions/archive-all", json={"archived": False}
    )
    assert restored.status_code == 200 and restored.json()["affected"] == 105
    assert all(item["archived"] is False for item in restored.json()["sessions"])
    assert (
        await client.post(prefix + "/sessions/read", json=["batch-000"] * 1001)
    ).status_code == 422
