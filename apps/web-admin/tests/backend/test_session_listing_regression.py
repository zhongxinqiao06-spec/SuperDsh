"""隔离 PostgreSQL 验证列表全量目录与真正SQL键集分页，不依赖内存排序替身。"""

import base64
import json
from datetime import UTC, datetime

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.conversations.entity.do.models import SessionRow
from app.modules.conversations.service.conversation_service import ConversationService


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_inventory_and_keyset_survive_deleted_or_moved_anchor(
    platform: tuple[FastAPI, AsyncClient], prefix: str
) -> None:
    """126条合成事实覆盖默认100、归档目录、撤销设备以及锚点变更后的稳定续页。"""
    app, client = platform
    account = await bootstrap(client, prefix)
    connector = (await client.post(prefix + "/connectors", json={"name": "列表合成设备"})).json()[
        "connector"
    ]["id"]
    revoked = (await client.post(prefix + "/connectors", json={"name": "已撤销合成设备"})).json()[
        "connector"
    ]["id"]
    project = (
        await client.post(
            prefix + "/projects",
            json={"connectorId": connector, "name": "列表项目", "workspacePath": "/synthetic/list"},
        )
    ).json()["project"]["id"]
    conversations: ConversationService = app.state.services.conversations
    now = datetime(2026, 1, 1, tzinfo=UTC)
    async with conversations.repository.transaction() as dao:
        for index in range(126):
            await dao.save(
                SessionRow(
                    id=f"list-{index:03}",
                    owner_id=str(account["userId"]),
                    connector_id=revoked if index == 125 else connector,
                    project_id=project,
                    runtime_id="controlled",
                    runtime_type="controlled",
                    title="列表合成会话",
                    cwd="/synthetic/list",
                    source={},
                    state={},
                    status="idle",
                    sequence=index % 3,
                    last_item_order_seq=index % 4 if index % 5 else None,
                    latest_turn_end_seq=0,
                    last_read_seq=0,
                    archived=index >= 120,
                    pinned=index % 7 == 0,
                    takeover=False,
                    sort_at=now,
                    created_at=now,
                    updated_at=now,
                )
            )
    assert (await client.delete(prefix + "/connectors/" + revoked)).status_code == 204
    default = await client.get(prefix + "/sessions")
    assert default.status_code == 200, default.text
    assert len(default.json()["sessions"]) == 100 and default.json()["hasMore"] is True
    inventory = await client.get(
        prefix + "/sessions/list", params={"limit": 0, "cursor": "invalid", "archived": "false"}
    )
    assert inventory.status_code == 200, inventory.text
    assert len(inventory.json()["sessions"]) == 125 and inventory.json()["hasMore"] is False
    assert sum(row["archived"] for row in inventory.json()["sessions"]) == 5
    assert inventory.json()["nextCursor"] is None
    first = (await client.get(prefix + "/sessions", params={"limit": 10})).json()
    cursor = first["nextCursor"]
    decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    assert set(decoded) == {"v", "p", "s", "o", "u", "i"}
    second = (await client.get(prefix + "/sessions", params={"limit": 10, "cursor": cursor})).json()
    expected_ids = [row["id"] for row in second["sessions"]]
    assert set(expected_ids).isdisjoint(row["id"] for row in first["sessions"])
    async with conversations.repository.transaction() as dao:
        anchor = await dao.session(decoded["i"])
        assert anchor is not None
        await dao.db.delete(anchor)
    after_delete = await client.get(prefix + "/sessions", params={"limit": 10, "cursor": cursor})
    assert (
        after_delete.status_code == 200
        and [row["id"] for row in after_delete.json()["sessions"]] == expected_ids
    )
    move_cursor = second["nextCursor"]
    third = (
        await client.get(prefix + "/sessions", params={"limit": 10, "cursor": move_cursor})
    ).json()
    async with conversations.repository.transaction() as dao:
        anchor = await dao.session(second["sessions"][-1]["id"])
        assert anchor is not None
        anchor.pinned, anchor.sort_at = True, datetime(2030, 1, 1, tzinfo=UTC)
        await dao.save(anchor)
    after_move = (
        await client.get(prefix + "/sessions", params={"limit": 10, "cursor": move_cursor})
    ).json()
    assert [row["id"] for row in after_move["sessions"]] == [row["id"] for row in third["sessions"]]
    for value in (0, 101, "1.5"):
        response = await client.get(prefix + "/sessions", params={"limit": value})
        assert (
            response.status_code == 422 and response.json()["detail"] == "invalid integer parameter"
        )
    for value in ("invalid", "eyJpIjoibGlzdC0wMDEifQ"):
        response = await client.get(prefix + "/sessions", params={"cursor": value})
        assert response.status_code == 400 and response.json()["detail"] == "invalid session cursor"
    assert (await client.get(prefix + "/projects/foreign-project/sessions")).status_code == 404
