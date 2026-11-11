"""旧终端普通/结果包裹入口与真实handler比较，原始RPC额外字段必须无损保留。"""

import asyncio
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.compatibility import CompatibilityCatalog, CompatibilityMiddleware
from app.api.dependencies import current_account
from app.infrastructure.database import Database
from app.modules.devices.controller.terminal_controller import router
from app.modules.devices.dao.operation_dao import OperationDao
from app.modules.devices.service import terminal_relay_service
from app.modules.devices.service.device_service import DeviceService
from app.modules.devices.service.terminal_relay_service import TerminalRelayService
from app.modules.devices.service.terminal_service import TerminalService
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]
ACCOUNT = Account("synthetic-owner", "synthetic", (), ("terminal.use",), 1)


@pytest.mark.parametrize("family", ["terminals", "terminals-v2"])
@pytest.mark.parametrize(
    "method,suffix,body,raw",
    [
        (
            "GET",
            "",
            {},
            {"terminals": [{"terminalId": "synthetic-terminal"}], "deviceExtension": "retained"},
        ),
        (
            "POST",
            "",
            {"root": "/workspace"},
            {"terminalId": "synthetic-terminal", "deviceExtension": "retained"},
        ),
        (
            "POST",
            "",
            {"root": "/workspace"},
            {"terminal": {"terminalId": "synthetic-terminal"}, "deviceExtension": "retained"},
        ),
        (
            "PATCH",
            "/{terminal_id}",
            {"label": "新名称"},
            {"terminalId": "synthetic-terminal", "label": "新名称", "deviceExtension": "retained"},
        ),
        (
            "POST",
            "/{terminal_id}/resize",
            {"cols": 120, "rows": 40},
            {
                "terminalId": "synthetic-terminal",
                "cols": 120,
                "rows": 40,
                "deviceExtension": "retained",
            },
        ),
        (
            "DELETE",
            "/{terminal_id}",
            {},
            {
                "terminalId": "synthetic-terminal",
                "status": "exited",
                "exitCode": 0,
                "deviceExtension": "retained",
            },
        ),
    ],
)
async def test_terminal_response_matches_actual_legacy_handler(
    family: str,
    method: str,
    suffix: str,
    body: dict[str, object],
    raw: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """只在入口选择响应表示；不得猜测拆terminal，遗漏原RPC顶层自定义字段。"""
    endpoint = "/connectors/{target_id}/" + family + suffix
    process = await asyncio.to_thread(
        subprocess.run,
        ["node", str(ROOT / "apps/web-admin/tests/parity/terminal-oracle.ts")],
        input=json.dumps(
            [
                {
                    "scope": "connectors",
                    "body": body,
                    "method": method,
                    "endpoint": endpoint,
                    "result": raw,
                }
            ]
        ),
        encoding="utf-8",
        capture_output=True,
        timeout=30,
        check=False,
        cwd=ROOT,
    )
    assert process.returncode == 0, process.stderr
    expected = json.loads(process.stdout)[0]
    database = Mock(spec=Database)
    session = AsyncMock()
    session.__aenter__.return_value = session
    session.begin = Mock(return_value=AsyncMock())
    database.sessions = Mock(return_value=session)
    dao = AsyncMock(spec=OperationDao)
    monkeypatch.setattr(terminal_relay_service, "OperationDao", lambda _: dao)
    devices = Mock(spec=DeviceService)
    devices.own = AsyncMock(
        return_value=SimpleNamespace(executor_kind="desktop", blocked_at=None, revoked=False)
    )
    devices.call = AsyncMock(return_value=raw)
    relay = TerminalRelayService(devices, database)
    monkeypatch.setattr(relay, "call", AsyncMock(return_value=raw))
    monkeypatch.setattr(relay, "binding", AsyncMock())
    devices.operations = SimpleNamespace(relay=relay)
    devices.terminals = TerminalService(devices, Mock())
    application = FastAPI()
    application.state.services = SimpleNamespace(devices=devices)
    application.dependency_overrides[current_account] = lambda: ACCOUNT
    application.include_router(router, prefix="/api")
    mapping = CompatibilityCatalog(ROOT / "apps/web-admin/deployment/compatibility-routes.json")
    application.add_middleware(CompatibilityMiddleware, catalog=mapping)
    path = "/api/v2" + endpoint.replace("{target_id}", "synthetic-connector").replace(
        "{terminal_id}", "synthetic-terminal"
    )
    async with AsyncClient(
        transport=ASGITransport(app=application), base_url="http://synthetic.invalid"
    ) as client:
        response = await client.request(method, path, json=body)
    assert response.status_code == 200, response.text
    actual = response.json()
    if "serverTime" in expected:
        assert isinstance(actual.get("serverTime"), str)
        expected.pop("serverTime")
        actual.pop("serverTime")
    assert actual == expected


@pytest.mark.parametrize(
    "method,suffix,body,raw",
    [
        (
            "PATCH",
            "/{terminal_id}/persistence",
            {"persistent": True},
            {"terminalId": "synthetic-terminal", "persistent": True, "deviceExtension": "retained"},
        ),
        (
            "POST",
            "/{terminal_id}/write",
            {"data": "synthetic"},
            {"terminalId": "synthetic-terminal", "scrollbackSeq": 4, "deviceExtension": "retained"},
        ),
        (
            "GET",
            "/{terminal_id}/snapshot",
            {},
            {
                "terminalId": "synthetic-terminal",
                "dataBase64": "aGVsbG8=",
                "seq": 4,
                "deviceExtension": "retained",
            },
        ),
    ],
)
async def test_terminal_result_operations_keep_raw_protocol(
    method: str,
    suffix: str,
    body: dict[str, object],
    raw: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """结果封装入口特有的写入、持久化和输出快照不额外套terminal或丢协议字段。"""
    await test_terminal_response_matches_actual_legacy_handler(
        "terminals-v2",
        method,
        suffix,
        body,
        raw,
        monkeypatch,
    )
