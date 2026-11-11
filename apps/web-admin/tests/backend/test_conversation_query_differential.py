"""相同URL输入执行旧真实HTTP处理器/SQL分页与新HTTP处理器，SQL传输为合成内存。"""

import json
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import MethodType, SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.modules.conversations.controller.conversation_controller import router
from app.modules.conversations.dao.conversation_dao import ConversationDao
from app.modules.conversations.entity.do.models import SessionRow, TimelineRow
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.conversations.service.query_service import ConversationQueryService
from app.modules.conversations.service.views import session_view
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]
ACCOUNT = Account("synthetic-owner", "synthetic", (), ("sessions.read",), 1)
CASES: list[dict[str, object]] = (
    [
        dict[str, object](endpoint="timeline", query=query)
        for query in (
            {},
            {"limit": "2"},
            {"mode": "history", "beforeOrderSeq": "4", "limit": "2"},
            {"mode": "changes", "afterSeq": "518", "limit": "10"},
            {"mode": "changes", "afterSeq": "1000"},
            {"limit": "500"},
            {"limit": ""},
            {"limit": "1e1"},
            {"limit": "0x10"},
            {"limit": "1_0"},
            {"limit": "１"},
            {"limit": "0"},
            {"limit": "501"},
            {"limit": "1.5"},
            {"afterSeq": "9007199254740992"},
            {"mode": "other"},
            {"mode": "history"},
            {"mode": "history", "beforeOrderSeq": ""},
            {"mode": "history", "beforeOrderSeq": "-1"},
        )
    ]
    + [
        dict[str, object](endpoint="snapshot", query=query)
        for query in ({"limit": "2"}, {"limit": "501"})
    ]
    + [
        dict[str, object](endpoint="events", query=query)
        for query in (
            {},
            {"after": "seq:518", "limit": "10"},
            {"after": "seq:1000"},
            {"after": "seq:1001", "limit": "bad"},
            {"after": "seq:518", "cursor": "broken", "limit": "10"},
            {"cursor": "seq:900"},
            {"cursor": "1000"},
            {"cursor": "seq:01"},
            {"cursor": "seq:-1"},
            {"cursor": "seq:１"},
            {"cursor": "seq:9007199254740992"},
            {"cursor": "seq:1", "limit": "501"},
        )
    ]
    + [
        {"endpoint": "events", "query": {"after": "seq:518", "limit": "10"}, "reset": 800},
        {"endpoint": "events", "query": {"after": "seq:518", "limit": "10"}, "concurrent": True},
    ]
)


@pytest.fixture(scope="module")
def expected() -> list[dict[str, object]]:
    """只读加载冻结的旧处理器，返回观测值而非新实现自行编写的预期。"""
    result = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/conversation-query-oracle.ts")],
        input=json.dumps(CASES),
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=30,
        cwd=ROOT,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return cast(list[dict[str, object]], json.loads(result.stdout))


def application(case: dict[str, object]) -> tuple[FastAPI, AsyncMock]:
    """纯测试替换DAO传输；实际QueryService、Controller、视图和边界校验保留。"""
    row = SessionRow(
        id="synthetic-session",
        owner_id=ACCOUNT.user_id,
        connector_id="synthetic-connector",
        runtime_id="controlled",
        runtime_type="controlled",
        sequence=1000,
        status="idle",
        title="查询差分",
        source={},
        state={},
        takeover=False,
        pinned=False,
        archived=False,
        last_read_seq=0,
        latest_turn_end_seq=0,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    items = [
        TimelineRow(
            session_id=row.id,
            item_id=f"item-{index:03}",
            order_seq=index,
            sequence=900 if index == 1 else index,
            payload={
                "type": "message",
                "revision": 2 if index == 1 else 1,
                "content": f"正文{index}",
                "orderSeq": -1,
                "updatedSeq": -1,
            },
        )
        for index in range(1, 521)
    ]
    dao = AsyncMock(spec=ConversationDao)
    dao.session.return_value = row
    dao.timeline_reset_sequence.return_value = case.get("reset", 0)

    def select_items(
        _: str, mode: str, after: int, before: int | None, limit: int
    ) -> list[TimelineRow]:
        selected = [
            item
            for item in items
            if (
                item.sequence > after
                if mode == "changes"
                else item.order_seq < before
                if mode == "history" and before is not None
                else True
            )
        ]
        return sorted(
            selected,
            key=lambda item: (item.sequence if mode == "changes" else item.order_seq, item.item_id),
            reverse=mode != "changes",
        )[:limit]

    dao.timeline_items.side_effect = select_items

    @asynccontextmanager
    async def transaction() -> AsyncIterator[AsyncMock]:
        yield dao

    service = Mock(spec=ConversationService)
    for name in ("timeline", "snapshot", "recover_events"):
        setattr(service, name, MethodType(getattr(ConversationService, name), service))
    service.repository = Mock(transaction=transaction)
    service.projection = Mock(sync=AsyncMock())
    service.queries = ConversationQueryService(service)
    reads = 0

    async def own(*_: object) -> SessionRow:
        nonlocal reads
        reads += 1
        if case.get("concurrent") and reads > 1:
            changed = SessionRow(id=row.id, owner_id=row.owner_id, sequence=1001)
            return changed
        return row

    service.own = AsyncMock(side_effect=own)
    service.view = AsyncMock(side_effect=lambda _account, value: session_view(value))
    service.runtime_capabilities = AsyncMock(return_value={"revision": 0, "capabilities": []})
    app = FastAPI()
    app.state.services = SimpleNamespace(conversations=service)
    app.dependency_overrides[current_account] = lambda: ACCOUNT
    app.include_router(router, prefix="/api")

    @app.exception_handler(DomainError)
    async def domain_error(_: Request, error: DomainError) -> JSONResponse:
        return JSONResponse({"detail": error.detail}, status_code=error.status)

    return app, dao


def observation(endpoint: str, raw: dict[str, object]) -> dict[str, object]:
    """只比较本用例负责的游标/页/恢复内容；时间、事件摘要和会话总视图有独立测试。"""
    body = dict(raw)
    body.pop("serverTime", None)
    if endpoint == "snapshot" and "timeline" in body:
        return {key: body[key] for key in ("timeline", "eventCursor")}
    if endpoint == "events" and isinstance(body.get("events"), list):
        events = cast(list[dict[str, object]], body["events"])
        body["events"] = sorted(
            [
                {
                    "type": event["type"],
                    "sequence": event["sequence"],
                    "item": cast(dict[str, object], event["payload"]).get("item"),
                }
                for event in events
            ],
            key=lambda event: (int(str(event["sequence"])), str(event["type"])),
        )
    return body


@pytest.mark.parametrize("index", range(len(CASES)))
async def test_same_query_against_legacy_and_current(
    index: int, expected: list[dict[str, object]]
) -> None:
    case = CASES[index]
    app, dao = application(case)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://synthetic") as client:
        response = await client.get(
            f"/api/sessions/synthetic-session/{case['endpoint']}",
            params=cast(dict[str, str], case["query"]),
        )
    assert response.status_code == expected[index]["status"], (case, response.text, expected[index])
    assert observation(str(case["endpoint"]), response.json()) == observation(
        str(case["endpoint"]), cast(dict[str, object], expected[index]["body"])
    ), case
    if response.status_code == 200 and case["endpoint"] in {"timeline", "snapshot"}:
        dao.lock.assert_awaited_with("synthetic-session")
