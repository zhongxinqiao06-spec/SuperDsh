"""旧真实工作区/Store与新项目服务对照，合成仓储不冒充实际数据库。"""

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
from app.modules.conversations.dao.conversation_dao import ConversationDao, ConversationRepository
from app.modules.conversations.entity.bo.workspace import workspace_key
from app.modules.conversations.entity.do.models import ProjectRow
from app.modules.conversations.entity.vo.conversation_dto import ProjectInput
from app.modules.conversations.service.project_service import ProjectService
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]
CASES: list[dict[str, object]] = [
    {"path": "/Work/../Project", "deviceOs": "linux", "manuallyCreated": False},
    {"path": "/work/project/", "deviceOs": "linux", "manuallyCreated": True},
    {"path": "//work//project//", "deviceOs": "linux"},
    {"path": "C:\\Work\\..\\Project\\", "deviceOs": "windows", "manuallyCreated": False},
    {"path": "c:/work/project", "deviceOs": "linux"},
    {"path": "\\\\Server\\Share\\Dir\\..\\Project", "deviceOs": "windows"},
    {"path": "/work/project", "deviceOs": "win32"},
    {"path": "relative/path", "deviceOs": "linux"},
    {"path": "/managed", "managed": True},
    {"path": "/elsewhere", "managed": True},
]


@pytest.fixture(scope="module")
def legacy_projects() -> list[dict[str, object]]:
    result = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/project-oracle.ts")],
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


@pytest.mark.parametrize("index", range(len(CASES)))
async def test_project_client_matches_actual_old_store(
    index: int, legacy_projects: list[dict[str, object]]
) -> None:
    """Android false、Windows/POSIX规范化与受管工作区约束走真实新服务。"""
    case = CASES[index]
    now = datetime.now(UTC)
    dao = Mock(spec=ConversationDao)
    dao.lock, dao.save = AsyncMock(), AsyncMock()
    dao.projects, dao.sessions = AsyncMock(return_value=[]), AsyncMock(return_value=[])
    dao.project = AsyncMock(
        return_value=ProjectRow(
            id="managed",
            owner_id="owner",
            connector_id="connector",
            name="合成项目",
            workspace_path="/managed",
            manually_created=False,
            pinned=False,
            created_at=now,
            updated_at=now,
        )
    )
    repository = Mock(spec=ConversationRepository)

    @asynccontextmanager
    async def transaction() -> AsyncIterator[ConversationDao]:
        yield dao

    repository.transaction = transaction
    devices = Mock(spec=DeviceService)
    devices.own = AsyncMock(
        return_value=Mock(
            id="connector",
            device_os=case.get("deviceOs"),
            executor_kind="server-agent" if case.get("managed") else "desktop",
        )
    )
    devices.native_ids.return_value = ("connector", "managed")
    service = ProjectService(repository, devices)
    path = str(case["path"])
    try:
        result = await service.create(
            Account("owner", "owner", (), ("projects.manage",), 1),
            ProjectInput(
                connectorId="connector",
                name="合成项目",
                workspacePath=path,
                manuallyCreated=case.get("manuallyCreated") is not False,
            ),
        )
        row = cast(dict[str, object], result["project"])
        observed = {
            "status": 200,
            "key": workspace_key(path, cast(str | None, case.get("deviceOs"))),
            "path": row["workspacePath"],
            "manuallyCreated": row["manuallyCreated"],
        }
        assert result["attachedSessions"] == 0 and isinstance(result["serverTime"], str)
    except DomainError as error:
        observed = {"status": error.status, "detail": error.detail}
    assert observed == legacy_projects[index]
