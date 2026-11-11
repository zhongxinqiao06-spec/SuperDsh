"""真实旧列表handler/Store与新listing服务差分，使用同一组多字段排序事实。"""

import json
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest

from app.infrastructure.errors import DomainError
from app.modules.conversations.dao.conversation_dao import ConversationDao
from app.modules.conversations.entity.bo.session_cursor import SessionCursor, cursor_time
from app.modules.conversations.entity.do.models import SessionRow
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.conversations.service.listing_service import SessionListingService
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]
ACCOUNT = Account("owner", "owner", (), ("sessions.read",), 1)
CASES: list[dict[str, object]] = [
    {"endpoint": "sessions", "query": {}},
    {"endpoint": "inventory", "query": {"archived": "false", "limit": "1", "cursor": "invalid"}},
    {"endpoint": "sessions", "query": {"archived": "true"}},
    {"endpoint": "project", "query": {"limit": "2"}},
    {"endpoint": "sessions", "query": {"limit": "10"}, "anchor": 9},
    {"endpoint": "sessions", "query": {"limit": "10"}, "anchor": 9, "mutate": "delete"},
    {"endpoint": "sessions", "query": {"limit": "10"}, "anchor": 9, "mutate": "move"},
    {"endpoint": "sessions", "query": {"limit": "0"}},
    {"endpoint": "sessions", "query": {"limit": "101"}},
    {"endpoint": "sessions", "query": {"limit": "1.5"}},
    {"endpoint": "sessions", "query": {"cursor": "invalid"}},
    {"endpoint": "sessions", "query": {"cursor": "eyJpIjoibGlzdC0wMDEifQ"}},
]


@pytest.fixture(scope="module")
def observed_legacy() -> list[dict[str, object]]:
    process = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/session-list-oracle.ts")],
        input=json.dumps(CASES),
        text=True,
        encoding="utf-8",
        capture_output=True,
        cwd=ROOT,
        timeout=30,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    return cast(list[dict[str, object]], json.loads(process.stdout))


def ordering(row: SessionRow) -> tuple[int, str, int, int, str]:
    return (
        int(row.pinned),
        cursor_time(row.sort_at or row.updated_at),
        row.last_item_order_seq if row.last_item_order_seq is not None else -1,
        row.sequence,
        row.id,
    )


@pytest.mark.parametrize("index", range(len(CASES)))
async def test_list_matches_old_handlers(
    index: int, observed_legacy: list[dict[str, object]]
) -> None:
    case, expected = CASES[index], observed_legacy[index]
    query = cast(dict[str, str], expected["query"])
    now = datetime(2026, 1, 1, tzinfo=UTC)
    rows = [
        SessionRow(
            id=f"list-{item:03}",
            owner_id="owner",
            connector_id="revoked" if item == 125 else "connector",
            project_id="project",
            pinned=item % 7 == 0,
            archived=item >= 120,
            sort_at=now,
            updated_at=now,
            created_at=now,
            last_item_order_seq=item % 4 if item % 5 else None,
            sequence=item % 3,
            source={},
            state={},
            runtime_type="dsh",
            runtime_id="dsh",
            last_read_seq=0,
            latest_turn_end_seq=0,
        )
        for item in range(126)
    ]
    if case.get("anchor") is not None:
        anchor = sorted(
            [row for row in rows if not row.archived and row.connector_id != "revoked"],
            key=ordering,
            reverse=True,
        )[int(str(case["anchor"]))]
        if case.get("mutate") == "delete":
            rows.remove(anchor)
        elif case.get("mutate") == "move":
            anchor.pinned, anchor.sort_at = True, datetime(2030, 1, 1, tzinfo=UTC)
    dao = AsyncMock(spec=ConversationDao)
    dao.project.return_value = Mock(owner_id="owner")

    def selected(
        _owner: str,
        connectors: list[str],
        filters: dict[str, str],
        cursor: SessionCursor | None,
        limit: int | None,
        inventory: bool,
    ) -> list[SessionRow]:
        visible = [
            row
            for row in rows
            if row.connector_id in connectors
            and (inventory or row.archived == (filters.get("archived") == "true"))
        ]
        if cursor:
            key = (
                cursor.pinned,
                cursor.sort_at,
                cursor.item_order,
                cursor.sequence,
                cursor.identifier,
            )
            visible = [row for row in visible if ordering(row) < key]
        visible.sort(key=ordering, reverse=True)
        return visible if limit is None else visible[: limit + 1]

    dao.session_page.side_effect = selected

    @asynccontextmanager
    async def transaction() -> AsyncIterator[AsyncMock]:
        yield dao

    service = Mock(spec=ConversationService)
    service.repository = Mock(transaction=transaction)
    service.projection = Mock(sync=AsyncMock())
    service.devices = Mock(conversation_sources=AsyncMock(return_value={"connector": False}))
    try:
        result = await SessionListingService(service).listing(
            ACCOUNT,
            {**query, **({"projectId": "project"} if case["endpoint"] == "project" else {})},
            case["endpoint"] == "inventory",
        )
        sessions = cast(list[dict[str, object]], result["sessions"])
        actual = {
            "status": 200,
            "query": query,
            "ids": [row["id"] for row in sessions],
            "nextCursor": result["nextCursor"],
            "hasMore": result["hasMore"],
        }
    except DomainError as error:
        actual = {"status": error.status, "query": query, "detail": error.detail}
    assert actual == expected
