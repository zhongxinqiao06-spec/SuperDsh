"""真实隔离 PostgreSQL 投影后验证两类入口的分页、修订恢复与完整替换。"""

from typing import cast

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_history_changes_and_recovery_use_durable_sequence(
    platform: tuple[FastAPI, AsyncClient], prefix: str
) -> None:
    """520条真实行防止隐藏201上限，修订的更新序列不能被消息展示顺序替代。"""
    _, client = platform
    await bootstrap(client, prefix)
    registered = (await client.post(prefix + "/connectors", json={"name": "查询合成设备"})).json()
    credential = f"Connector {registered['connector']['id']}:{registered['connectorToken']}"
    auth = await client.post(prefix + "/connector/auth", headers={"Authorization": credential})
    assert auth.status_code == 200, auth.text
    headers = {"Authorization": "Bearer " + auth.json()["accessToken"]}
    session = "query-synthetic-session"
    identity = {"sessionId": session, "runtime": "controlled", "runtimeId": "controlled"}

    async def ingest(method: str, params: dict[str, object]) -> None:
        response = await client.post(
            prefix + "/connector/ingest",
            headers=headers,
            json={"notifications": [{"method": method, "params": {**identity, **params}}]},
        )
        assert response.status_code == 200 and response.json()["accepted"] == 1, response.text

    await ingest("session.created", {"title": "查询协议"})
    items = [
        {
            "id": f"item-{index:03}",
            "type": "message",
            "role": "assistant",
            "revision": 1,
            "orderSeq": index,
            "content": f"正文{index}",
        }
        for index in range(1, 521)
    ]
    await ingest("timeline.sync", {"items": items, "complete": True})
    base = f"{prefix}/sessions/{session}"
    latest_response = await client.get(base + "/timeline", params={"limit": 500})
    assert latest_response.status_code == 200, latest_response.text
    latest = latest_response.json()
    sequence = latest["nextSeq"]
    assert len(latest["items"]) == 500 and latest["hasMore"] is True
    assert latest["items"][0]["id"] == "item-021"
    assert latest["items"][-1]["id"] == "item-520" and sequence >= 520
    history = (
        await client.get(
            base + "/timeline", params={"mode": "history", "beforeOrderSeq": 21, "limit": 500}
        )
    ).json()
    assert len(history["items"]) == 20 and history["hasMore"] is False
    assert history["nextSeq"] == sequence and history["items"][0]["orderSeq"] == 1
    snapshot = (await client.get(base + "/snapshot", params={"limit": 2})).json()
    assert [item["id"] for item in snapshot["timeline"]["items"]] == ["item-519", "item-520"]
    assert snapshot["eventCursor"] == f"seq:{sequence}"
    assert snapshot["timeline"]["nextSeq"] == sequence
    await ingest("timeline.itemUpsert", {"item": {**items[0], "content": "修改后", "revision": 2}})
    changes = (
        await client.get(base + "/timeline", params={"mode": "changes", "afterSeq": sequence})
    ).json()
    assert len(changes["items"]) == 1 and changes["items"][0]["id"] == "item-001"
    changed = changes["items"][0]
    assert changed["orderSeq"] == 1 and changed["updatedSeq"] > sequence
    recovered = (
        await client.get(base + "/events", params={"after": f"seq:{sequence}", "cursor": "invalid"})
    ).json()
    assert recovered["snapshotRequired"] is False
    assert recovered["nextCursor"] == f"seq:{changed['updatedSeq']}"
    assert {event["type"] for event in recovered["events"]} == {
        "timeline.item_updated",
        "session.meta.updated",
        "runtime.state.updated",
        "runtime.capability.updated",
    }
    state = next(event for event in recovered["events"] if event["type"] == "runtime.state.updated")
    assert state["payload"]["state"]["updatedSeq"] == changed["updatedSeq"]
    for cursor in ("seq:0", f"seq:{changed['updatedSeq'] + 1}"):
        overflow = (await client.get(base + "/events", params={"after": cursor, "limit": 2})).json()
        assert overflow["snapshotRequired"] is True and overflow["events"] == []
    await ingest("timeline.sync", {"items": items[-2:], "complete": True})
    reset = (
        await client.get(base + "/events", params={"after": f"seq:{changed['updatedSeq']}"})
    ).json()
    assert reset["snapshotRequired"] is True and reset["events"] == []
    remaining = (await client.get(base + "/timeline")).json()
    assert len(remaining["items"]) == 2 and remaining["hasMore"] is False
    assert int(reset["nextCursor"][4:]) == remaining["nextSeq"]
    # 完整同步内容未变时不制造新重置事件，保证客户端恢复游标幂等。
    await ingest("timeline.sync", {"items": items[-2:], "complete": True})
    repeated = (await client.get(base + "/timeline")).json()
    assert repeated["nextSeq"] == remaining["nextSeq"]
    for cursor in ("seq:01", "seq:" + "9" * 5000, "seq:１", "1"):
        rejected = await client.get(base + "/events", params={"cursor": cursor})
        assert rejected.status_code == 422 and rejected.json()["detail"] == "invalid event cursor"
    for path in ("timeline?mode=history", "timeline?mode=bad", "snapshot?limit=501"):
        assert (await client.get(base + "/" + path)).status_code == 422
    assert all(
        isinstance(item["updatedSeq"], int)
        for item in cast(list[dict[str, object]], latest["items"])
    )
