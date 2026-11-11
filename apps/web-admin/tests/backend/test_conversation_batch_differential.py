"""旧批量真实handler与新用例成对执行，覆盖完整集合、失败不写和读序列语义。"""

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
from app.modules.conversations.entity.do.models import SessionRow
from app.modules.conversations.service.batch_service import SessionBatchService
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.identity.entity.bo.models import Account

CASES: list[dict[str, object]] = [
    {"operation": "read", "value": []},
    {"operation": "read", "value": ["session-0", "session-104"]},
    {"operation": "archive", "value": ["session-0", "session-0"]},
    {"operation": "unarchive", "value": ["session-1"]},
    {"operation": "read", "value": {"sessionIds": ["session-0"]}},
    {"operation": "read", "value": ["session-0"] * 1001},
    {"operation": "archive", "value": ["session-0", "foreign-session"]},
    {
        "operation": "archive",
        "value": {"archived": True, "scope": "ignored"},
        "all": True,
        "project": True,
    },
    {"operation": "archive", "value": {"archived": False}, "all": True},
    {
        "operation": "archive",
        "value": {},
        "all": True,
        "project": True,
        "target": "foreign-project",
    },
]
ROOT = Path(__file__).resolve().parents[4]
ACCOUNT = Account("owner", "owner", (), ("sessions.run", "sessions.read"), 1)


@pytest.fixture(scope="module")
def expected_batches() -> list[dict[str, object]]:
    process = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/conversation-batch-oracle.ts")],
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


@pytest.mark.parametrize("index", range(len(CASES)))
async def test_batch_matches_real_legacy_handler(
    index: int, expected_batches: list[dict[str, object]]
) -> None:
    case = CASES[index]
    rows = [
        SessionRow(
            id=f"session-{index}",
            owner_id="owner",
            connector_id="connector",
            project_id="project" if index < 103 else "other",
            sequence=40,
            latest_turn_end_seq=45,
            last_read_seq=0,
            archived=bool(index % 2),
            updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
        for index in range(105)
    ]
    dao = AsyncMock(spec=ConversationDao)
    dao.session.side_effect = lambda identifier: next(
        (row for row in rows if row.id == identifier), None
    )
    dao.project.side_effect = lambda identifier: (
        Mock(owner_id="owner", connector_id="connector") if identifier == "project" else None
    )
    dao.scoped_sessions.side_effect = lambda _owner, target, project: [
        row for row in rows if (row.project_id if project else row.connector_id) == target
    ]

    @asynccontextmanager
    async def transaction() -> AsyncIterator[AsyncMock]:
        yield dao

    service = Mock(spec=ConversationService)
    service.repository = Mock(transaction=transaction)

    async def own(_account: Account, identifier: str, _permission: str) -> SessionRow:
        row = await dao.session(identifier)
        if not row:
            raise DomainError(404, "session not found")
        return cast(SessionRow, row)

    async def emit(_dao: object, row: SessionRow, _kind: str, _value: object) -> None:
        row.sequence += 1

    service.own = own
    service.devices = Mock(own=AsyncMock())
    service.projection = Mock(emit=emit)
    service.view = AsyncMock(
        side_effect=lambda _account, row, _permission: {
            "id": row.id,
            "archived": row.archived,
            "updatedSeq": row.sequence,
            "lastReadSeq": row.last_read_seq,
        }
    )
    batch = SessionBatchService(service)
    try:
        if case.get("all"):
            project = bool(case.get("project"))
            output = await batch.archive_all(
                ACCOUNT,
                str(case.get("target") or ("project" if project else "connector")),
                project,
                cast(dict[str, object], case["value"]),
            )
        else:
            output = await batch.update(ACCOUNT, str(case["operation"]), case["value"])
        observed = {"status": 200, "affected": output["affected"], "sessions": output["sessions"]}
    except DomainError as error:
        observed = {"status": error.status, "detail": error.detail}
    observed["facts"] = [
        {
            "id": row.id,
            "archived": row.archived,
            "sequence": row.sequence,
            "lastRead": row.last_read_seq,
        }
        for row in rows
    ]
    assert observed == expected_batches[index]
