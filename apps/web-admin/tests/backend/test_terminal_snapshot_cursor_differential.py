"""非零输出游标经过真实旧handler及新controller/service/relay，通道仅为受控端口。"""

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
from app.modules.devices.service.device_service import DeviceService
from app.modules.devices.service.terminal_relay_service import TerminalRelayService
from app.modules.devices.service.terminal_service import TerminalService
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]


@pytest.mark.parametrize("cursor", [7, 4096])
@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_nonzero_snapshot_cursor_matches_actual_legacy_handler(
    cursor: int,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """fromSeq优先于新别名，浏览根/终端身份覆盖在relay层且原RPC响应不丢失。"""
    raw = {
        "terminalId": "synthetic-terminal",
        "seq": cursor + 1,
        "dataBase64": "b2s=",
        "reset": False,
    }
    query = f"?fromSeq={cursor}&afterSeq=1"
    result = await asyncio.to_thread(
        subprocess.run,
        ["node", str(ROOT / "apps/web-admin/tests/parity/terminal-oracle.ts")],
        input=json.dumps(
            [
                {
                    "scope": "connectors",
                    "body": {},
                    "method": "GET",
                    "query": query,
                    "endpoint": "/connectors/{target_id}/terminals-v2/{terminal_id}/snapshot",
                    "result": raw,
                    "captureParameters": True,
                }
            ]
        ),
        encoding="utf-8",
        capture_output=True,
        check=False,
        timeout=30,
        cwd=ROOT,
    )
    assert result.returncode == 0, result.stderr
    expected = json.loads(result.stdout)[0]
    devices = Mock(spec=DeviceService)
    devices.own = AsyncMock(return_value=SimpleNamespace(executor_kind="desktop"))
    relay = TerminalRelayService(devices, Mock(spec=Database))
    binding = SimpleNamespace(
        session_id="browse_synthetic-connector", root="/workspace", cwd="/workspace"
    )
    monkeypatch.setattr(relay, "binding", AsyncMock(return_value=binding))
    frames: list[dict[str, object]] = []
    connection = SimpleNamespace(pending={}, writer=asyncio.Lock(), socket=AsyncMock())

    async def send(frame: dict[str, object]) -> None:
        frames.append(frame)
        connection.pending[frame["requestId"]].set_result(raw)

    connection.socket.send_json.side_effect = send
    monkeypatch.setattr(relay, "_connection", AsyncMock(return_value=connection))
    devices.operations = SimpleNamespace(relay=relay)
    devices.terminals = TerminalService(devices, Mock())
    application = FastAPI()
    application.state.services = SimpleNamespace(devices=devices)
    application.dependency_overrides[current_account] = lambda: Account(
        "synthetic-owner", "synthetic", (), ("terminal.use",), 1
    )
    application.include_router(router, prefix="/api")
    application.add_middleware(
        CompatibilityMiddleware,
        catalog=CompatibilityCatalog(ROOT / "apps/web-admin/deployment/compatibility-routes.json"),
    )
    family = "terminals-v2" if prefix == "/api/v2" else "terminals"
    async with AsyncClient(
        transport=ASGITransport(app=application), base_url="http://synthetic.invalid"
    ) as client:
        response = await client.get(
            f"{prefix}/connectors/synthetic-connector/{family}/synthetic-terminal/snapshot{query}"
        )
    assert response.status_code == 200, response.text
    assert len(frames) == 1 and not connection.pending
    assert {key: frames[0][key] for key in expected["params"]} == expected["params"]
    assert frames[0]["afterSeq"] == cursor
    observed = response.json()
    if prefix == "/api/v2":
        assert observed == expected["response"]
    else:
        assert {key: observed[key] for key in raw} == expected["response"]["result"]
        assert observed["data"] == "ok" and observed["sequence"] == cursor + 1
