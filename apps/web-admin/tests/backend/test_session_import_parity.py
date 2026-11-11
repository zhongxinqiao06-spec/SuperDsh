"""旧真实导入handler/Store与新导入服务，明确替换SQL和连接事实，禁止触发执行。"""

import json
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest

from app.infrastructure.errors import DomainError
from app.modules.conversations.dao.conversation_dao import ConversationDao
from app.modules.conversations.entity.do.models import ProjectRow, SessionRow
from app.modules.conversations.entity.vo.import_dto import ImportSessionInput
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.conversations.service.import_service import SessionImportService
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]
BODY: dict[str, object] = {
    "connectorId": "connector",
    "projectId": "project",
    "runtime": "dsh",
    "externalSessionId": "existing",
}
CASES: list[dict[str, object]] = [
    {"bodies": [{key: value for key, value in BODY.items() if key != "externalSessionId"}]},
    {"bodies": [BODY, BODY]},
    {"bodies": [{**BODY, "clientMessageId": "stable"}, {**BODY, "clientMessageId": "stable"}]},
    {
        "bodies": [
            {**BODY, "clientMessageId": "stable"},
            {**BODY, "clientMessageId": "stable", "externalSessionId": "changed"},
        ]
    },
    {
        "bodies": [
            {**BODY, "clientMessageId": "stable"},
            {
                **BODY,
                "clientMessageId": "stable",
                "connectorId": "other",
                "projectId": "project-other",
            },
        ]
    },
    {"bodies": [{**BODY, "projectId": "foreign"}]},
    {"bodies": [{**BODY, "projectId": "project-other"}]},
    {"bodies": [{**BODY, "cwd": "/different"}]},
    {"bodies": [BODY], "configured": False},
    {"bodies": [{**BODY, "cwd": "/workspace"}], "native": True},
    {"bodies": [{**BODY, "runtimeId": "other"}], "native": True},
]


@pytest.fixture(scope="module")
def legacy_imports() -> list[list[dict[str, object]]]:
    result = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/session-import-oracle.ts")],
        input=json.dumps(CASES),
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=30,
        cwd=ROOT,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return cast(list[list[dict[str, object]]], json.loads(result.stdout))


@pytest.mark.parametrize("index", range(len(CASES)))
async def test_import_matches_actual_old_handler(
    index: int, legacy_imports: list[list[dict[str, object]]]
) -> None:
    case = CASES[index]
    rows: list[SessionRow] = []
    dao = Mock(spec=ConversationDao)
    dao.lock = AsyncMock()

    async def save(row: SessionRow) -> None:
        rows.append(row)

    async def creation(owner: str, key: str) -> SessionRow | None:
        return next((row for row in rows if row.creation_key == key), None)

    async def project(identifier: str) -> ProjectRow | None:
        return (
            None
            if identifier == "foreign"
            else ProjectRow(
                id=identifier,
                owner_id="owner",
                connector_id="other" if identifier == "project-other" else "connector",
                workspace_path="/synthetic",
            )
        )

    dao.creation, dao.project, dao.save = creation, project, save

    @asynccontextmanager
    async def transaction() -> AsyncIterator[ConversationDao]:
        yield dao

    conversations = Mock(spec=ConversationService)
    conversations.repository = Mock(transaction=transaction)
    conversations.devices = Mock()
    conversations.devices.native_ids.return_value = ("connector", "project")

    async def own(account: Account, identifier: str, permission: str) -> object:
        return Mock(
            id=identifier,
            device_os="linux",
            executor_kind="server-agent" if case.get("native") else "desktop",
        )

    conversations.devices.own = own
    conversations.devices.runtimes.require_configured = AsyncMock(
        side_effect=DomainError(409, "runtime is not configured")
        if case.get("configured") is False
        else None
    )

    async def view(account: Account, row: SessionRow, permission: str) -> dict[str, object]:
        return {"externalSessionId": row.external_session_id, "cwd": row.cwd}

    conversations.view = view
    service = SessionImportService(conversations)
    observed: list[dict[str, object]] = []
    for body in cast(list[dict[str, object]], case["bodies"]):
        try:
            result = await service.create(
                Account("owner", "owner", (), ("sessions.run",), 1),
                ImportSessionInput.model_validate(body),
            )
            observed.append(
                {
                    "status": 200,
                    **cast(dict[str, object], result["session"]),
                    "connectorResult": result["connectorResult"],
                    "count": len(rows),
                }
            )
        except DomainError as error:
            observed.append({"status": error.status, "detail": error.detail, "count": len(rows)})
    assert observed == legacy_imports[index]
    conversations.devices.call.assert_not_called()
