"""隔离 PostgreSQL 验证删除事务和持久墓碑；只替换外部引擎读状态端口。"""

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.conversations.entity.do.models import (
    ConversationEventRow,
    ConversationShareRow,
    SessionRow,
    TimelineRow,
)
from app.modules.conversations.service.conversation_service import ConversationService


async def test_history_delete_persists_and_revokes_reads(
    platform: tuple[FastAPI, AsyncClient],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """完整事务清消息/分享，保留身份去重；迟到事件、列表和批量归档不能复活它。"""
    app, client = platform
    account = await bootstrap(client)
    connector = (await client.post("/api/connectors", json={"name": "删除隔离设备"})).json()[
        "connector"
    ]["id"]
    service: ConversationService = app.state.services.conversations
    now = datetime.now(UTC)
    identifier = "synthetic-delete-history"
    async with service.repository.transaction() as dao:
        await dao.save(
            SessionRow(
                id=identifier,
                owner_id=str(account["userId"]),
                connector_id=connector,
                runtime_id="controlled",
                runtime_type="controlled",
                title="合成历史",
                cwd="/synthetic",
                status="idle",
                source={},
                state={},
                sequence=1,
                latest_turn_end_seq=1,
                last_read_seq=1,
                archived=False,
                pinned=False,
                takeover=True,
                creation_key="synthetic-create",
                created_at=now,
                updated_at=now,
            )
        )
        await dao.save(
            TimelineRow(
                session_id=identifier,
                item_id="synthetic-message",
                sequence=1,
                order_seq=1,
                item_time=now,
                payload={"type": "message", "text": "合成内容"},
            )
        )
        await dao.save(
            ConversationEventRow(
                session_id=identifier,
                sequence=1,
                type="timeline.item_created",
                payload={},
                emitted_at=now,
            )
        )
        await dao.save(
            ConversationShareRow(
                id="synthetic-share",
                owner_id=str(account["userId"]),
                session_id=identifier,
                snapshot={},
                created_at=now,
            )
        )
    observed = AsyncMock(return_value={"status": "idle"})
    monkeypatch.setattr(service.actions, "command", observed)
    assert (await client.delete("/api/sessions/" + identifier)).status_code == 200
    assert (await client.delete("/api/sessions/" + identifier)).status_code == 200
    observed.assert_awaited_once()
    for suffix in ["meta", "snapshot", "timeline", "events", "agent-binding"]:
        response = await client.get(f"/api/sessions/{identifier}/{suffix}")
        assert response.status_code == 404, (suffix, response.status_code)
    assert (await client.post("/api/sessions/archive", json=[identifier])).status_code == 404
    assert (
        await client.post(
            "/api/ws-ticket",
            json={"clientId": "synthetic", "scope": {"sessionId": identifier}},
        )
    ).status_code == 404
    await service.projection.ingest(
        str(account["userId"]),
        connector,
        "session.meta.upsert",
        {
            "sessionId": identifier,
            "runtimeId": "controlled",
            "runtime": "controlled",
            "title": "迟到事件",
        },
    )
    async with service.repository.transaction() as dao:
        row = await dao.session(identifier)
        assert row is not None and row.source.get("historyDeletedAt") and row.title == "已删除会话"
        assert await dao.sessions(str(account["userId"])) == []
        assert await dao.scoped_sessions(str(account["userId"]), connector, False) == []
        assert await dao.session_page(str(account["userId"]), [connector], {}, None, 20, True) == []
        assert await dao.items(identifier) == []
        assert await dao.events(identifier, 0) == []
        assert await dao.share("synthetic-share") is None
        prior = await dao.creation(str(account["userId"]), "synthetic-create")
        assert prior is not None and prior.id == identifier
