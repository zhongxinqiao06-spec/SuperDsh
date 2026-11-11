"""运行配置拒绝和实例上限使用真实旧handler与新service，替换DAO/RPC不启动运行实例。"""

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.infrastructure.errors import DomainError
from app.modules.devices.dao.device_dao import DeviceDao
from app.modules.devices.entity.vo.device_dto import RuntimeInput
from app.modules.devices.service.device_service import DeviceService
from app.modules.devices.service.runtime_device_service import RuntimeDeviceService
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]
CASES = [
    {
        "validated": {"ok": False, "message": "synthetic model selection is invalid"},
        "count": 0,
        "maximum": 1,
    },
    {"validated": {"valid": False}, "count": 0, "maximum": 1},
    {"validated": {"valid": False, "message": 7}, "count": 0, "maximum": 1},
    {"validated": {"ok": True, "valid": True}, "count": 2, "maximum": 2},
]


@pytest.fixture(scope="module")
def runtime_create_oracle() -> list[dict[str, object]]:
    """只调用只读旧handler oracle一次，保留其明确错误文本。"""
    result = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/runtime-create-boundary-oracle.ts")],
        input=json.dumps(CASES),
        encoding="utf-8",
        capture_output=True,
        check=False,
        timeout=30,
        cwd=ROOT,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("index", range(len(CASES)))
async def test_runtime_create_rejection_matches_actual_legacy_handler(
    index: int,
    runtime_create_oracle: list[dict[str, object]],
) -> None:
    """失败前只有配置验证RPC，不写运行实例、不触发start，设备提供的具体原因保留。"""
    case = CASES[index]
    devices = Mock(spec=DeviceService)
    devices.own = AsyncMock(
        return_value=SimpleNamespace(
            executor_kind="desktop",
            metadata_json={
                "runtimeTypes": [{"runtimeType": "dsh", "maxInstances": case["maximum"]}]
            },
        )
    )
    devices.call = AsyncMock(return_value=case["validated"])
    dao = AsyncMock(spec=DeviceDao)
    dao.runtimes.return_value = [
        SimpleNamespace(runtime_type="dsh") for _ in range(int(str(case["count"])))
    ]
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    devices.repository = Mock()
    devices.repository.transaction.return_value = transaction
    service = RuntimeDeviceService(devices)
    with pytest.raises(DomainError) as raised:
        await service.create(
            Account("synthetic-owner", "synthetic", (), ("devices.manage",), 1),
            "synthetic-connector",
            RuntimeInput(runtimeType="dsh", name="合成实例", config={"model": "synthetic"}),
        )
    devices.call.assert_awaited_once()
    assert devices.call.await_args.args[2] == "runtime.validateConfig"
    validation = dict(devices.call.await_args.args[3])
    assert isinstance(validation.pop("runtimeId"), str)
    assert isinstance(validation.pop("configRevision"), int)
    observed = {
        "status": raised.value.status,
        "detail": raised.value.detail,
        "validation": validation,
        "writes": dao.save.await_count,
    }
    assert observed == runtime_create_oracle[index]
