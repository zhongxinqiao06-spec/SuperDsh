"""终端旧新真实handler参数差分与临时Home中的真实PTY，全部使用合成输入。"""

import asyncio
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.api.dependencies import current_account
from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.devices.controller.terminal_controller import router
from app.modules.devices.dao.operation_dao import OperationDao
from app.modules.devices.entity.vo.device_dto import TerminalInput
from app.modules.devices.service import terminal_relay_service
from app.modules.devices.service.device_service import DeviceService
from app.modules.devices.service.terminal_process import spawn
from app.modules.devices.service.terminal_relay_service import TerminalRelayService
from app.modules.devices.service.terminal_service import TerminalService
from app.modules.devices.service.workspace_service import WorkspaceService
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]
ACCOUNT = Account("synthetic-owner", "synthetic", (), ("terminal.use",), 1)


@pytest.mark.parametrize(
    "scope,body,query",
    [
        ("connectors", {"root": "/workspace"}, ""),
        (
            "connectors",
            {
                "root": "/workspace",
                "cwd": "nested",
                "shell": "/bin/sh",
                "args": ["-i"],
                "command": "printf hello",
                "label": "测试终端",
                "persistent": True,
                "env": {"SYNTHETIC": "1"},
                "profile": "custom",
                "ephemeralGroupId": "group",
            },
            "",
        ),
        (
            "connectors",
            {"root": "/ignored", "sessionId": "forged-session", "cols": 120, "rows": 42},
            "?root=/workspace",
        ),
        (
            "sessions",
            {
                "root": "/ignored",
                "sessionId": "forged-session",
                "cwd": "nested",
                "shell": "/bin/sh",
                "args": [],
            },
            "",
        ),
    ],
)
async def test_terminal_create_matches_actual_legacy_handler(
    scope: str,
    body: dict[str, object],
    query: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """客户端可配置shell等参数不能丢失，路由必须覆盖伪造的会话与根绑定。"""
    process = await asyncio.to_thread(
        subprocess.run,
        ["node", str(ROOT / "apps/web-admin/tests/parity/terminal-oracle.ts")],
        input=json.dumps([{"scope": scope, "body": body, "query": query}]),
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
    devices.call = AsyncMock(return_value={"terminal": {"terminalId": "generated"}})
    relay = TerminalRelayService(devices, database)
    devices.operations = SimpleNamespace(relay=relay)
    devices.terminals = TerminalService(devices, Mock())
    conversations = Mock()
    conversations.get_session = AsyncMock(
        return_value={"connectorId": "synthetic-connector", "cwd": "/workspace/session"}
    )
    application = FastAPI()
    application.state.services = SimpleNamespace(devices=devices, conversations=conversations)
    application.dependency_overrides[current_account] = lambda: ACCOUNT
    application.include_router(router, prefix="/api")
    target = "synthetic-session" if scope == "sessions" else "synthetic-connector"
    async with AsyncClient(
        transport=ASGITransport(app=application), base_url="http://synthetic.invalid"
    ) as client:
        response = await client.post(f"/api/{scope}/{target}/terminals{query}", json=body)
    assert response.status_code == 200, response.text
    params = cast(dict[str, object], devices.call.await_args.args[3])
    assert {**params, "terminalId": "<generated-terminal>"} == expected
    assert dao.save.await_count == 1


def test_terminal_defaults_and_invalid_process_parameters() -> None:
    """旧原生终端默认短标签和非持久状态；NUL不能进入操作系统进程参数。"""
    value = TerminalInput()
    assert value.name == "Shell" and value.persistence is False
    for payload in (
        {"shell": "bad\0shell"},
        {"args": ["bad\0arg"]},
        {"env": {"KEY": "bad\0value"}},
    ):
        with pytest.raises(ValidationError):
            TerminalInput.model_validate(payload)


async def test_custom_shell_arguments_run_in_real_temporary_pty(tmp_path: Path) -> None:
    """Windows或POSIX实际PTY，验证指定参数真正进入子进程并回收；不模拟设备。"""
    shell = "powershell.exe" if os.name == "nt" else "/bin/sh"
    args = (
        ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "Write-Output 'SYNTHETIC_CUSTOM_PTY'"]
        if os.name == "nt"
        else ["-c", "printf SYNTHETIC_CUSTOM_PTY; exec /bin/sh -i"]
    )
    process = await asyncio.to_thread(
        spawn, tmp_path / "workspace", tmp_path / "home", 24, 80, shell, args
    )
    output = ""
    try:
        assert process.pid > 0
        for _ in range(100):
            output += await asyncio.to_thread(process.read)
            if "SYNTHETIC_CUSTOM_PTY" in output:
                break
            await asyncio.sleep(0.05)
        assert "SYNTHETIC_CUSTOM_PTY" in output
    finally:
        await asyncio.to_thread(process.close)
    assert not process.alive()


async def test_native_terminal_command_metadata_and_browse_scope(tmp_path: Path) -> None:
    """真实PTY执行启动命令，设备浏览终端不会混入业务会话的列表或授权范围。"""
    devices = Mock(spec=DeviceService)
    devices.workspace.return_value = tmp_path / "workspace"
    devices.own = AsyncMock(
        return_value=SimpleNamespace(executor_kind="server-agent", blocked_at=None, revoked=False)
    )
    devices.identity = Mock()
    devices.identity.get_account = AsyncMock(return_value=ACCOUNT)
    devices.files = WorkspaceService(devices)
    service = TerminalService(devices, devices.files)
    command = (
        "Write-Output ('SYNTHETIC_' + 'STARTUP_COMMAND')"
        if os.name == "nt"
        else "printf 'SYNTHETIC_''STARTUP_COMMAND\\n'"
    )
    result = cast(
        dict[str, object],
        await service.create(ACCOUNT, "synthetic-connector", TerminalInput(command=command)),
    )
    view = cast(dict[str, object], result["terminal"])
    identifier = str(view["terminalId"])
    process = service.terminals[identifier].process
    try:
        assert view["label"] == "Shell" and view["persistent"] is False
        assert view["pid"] == process.pid and view["purpose"] == "user"
        assert view["sessionId"] == "browse_synthetic-connector"
        assert Path(str(view["root"])) == tmp_path / "workspace"
        assert (
            cast(
                dict[str, object],
                await service.listing(ACCOUNT, "synthetic-connector", "other-session"),
            )["terminals"]
            == []
        )
        await service.authorize_scope(ACCOUNT, "synthetic-connector", identifier, None)
        with pytest.raises(DomainError) as denied:
            await service.authorize_scope(
                ACCOUNT, "synthetic-connector", identifier, "other-session"
            )
        assert denied.value.status == 404
        for _ in range(100):
            snapshot = cast(
                dict[str, object],
                await service.snapshot(ACCOUNT, "synthetic-connector", identifier),
            )
            if "SYNTHETIC_STARTUP_COMMAND" in str(snapshot["data"]):
                break
            await asyncio.sleep(0.05)
        assert "SYNTHETIC_STARTUP_COMMAND" in str(snapshot["data"])
    finally:
        await service.close()
    assert not process.alive() and not service.terminals
