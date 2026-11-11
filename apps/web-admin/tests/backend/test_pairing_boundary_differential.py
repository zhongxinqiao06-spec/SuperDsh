"""旧真实配对handler与新service对照；仅替换DAO，不把受控端口计为实库。"""

import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from app.infrastructure.crypto import CredentialCipher, digest
from app.infrastructure.errors import DomainError
from app.modules.devices.dao.device_dao import DeviceDao, DeviceRepository
from app.modules.devices.entity.do.models import PairingRow
from app.modules.devices.entity.vo.device_dto import PairingClaim
from app.modules.devices.service.pairing_service import PairingService, make_device
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]
SCENARIOS = [
    "claim-missing",
    "claim-expired",
    "claim-claimed",
    "claim-foreign",
    "claim-token-wrong",
    "claim-token-missing",
    "poll-missing",
    "poll-consumed",
    "poll-expired",
    "poll-expired-consumed",
    "poll-pending",
    "poll-claimed",
]


@pytest.fixture(scope="module")
def pairing_oracle() -> list[dict[str, object]]:
    """一次执行旧handler取得本组基准，时间值单独归一化。"""
    result = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/pairing-boundary-oracle.ts")],
        input=json.dumps(SCENARIOS),
        encoding="utf-8",
        capture_output=True,
        check=False,
        timeout=30,
        cwd=ROOT,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("scenario", SCENARIOS)
async def test_pairing_matches_actual_legacy_handler(
    scenario: str,
    pairing_oracle: list[dict[str, object]],
) -> None:
    """错误不写配对状态；消费只清除本票据，过期状态优先于已消费。"""
    dao = AsyncMock(spec=DeviceDao)
    repository = Mock(spec=DeviceRepository)
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    repository.transaction.return_value = transaction
    cipher = Mock(spec=CredentialCipher)
    cipher.open.return_value = "synthetic-token"
    service = PairingService(repository, cipher)
    now = datetime.now(UTC)
    row = PairingRow(
        id="pair-synthetic",
        code_hash=digest("123456"),
        state="claimed" if scenario in {"claim-claimed", "poll-claimed"} else "pending",
        expires_at=now + timedelta(seconds=-60 if "expired" in scenario else 60),
        consumed_at=now if "consumed" in scenario else None,
        encrypted_token="synthetic-encrypted",
        connector_id="connector-synthetic",
        server_url="https://synthetic.invalid",
    )
    dao.pairing_code.return_value = None if scenario == "claim-missing" else row
    dao.pairing.return_value = None if scenario == "poll-missing" else row
    device, _ = make_device("synthetic-owner", "合成设备", "cli", "desktop", None)
    device.token_hash = digest("synthetic-token")
    dao.device.return_value = None if scenario == "claim-foreign" else device
    account = Account("synthetic-owner", "synthetic", (), ("devices.manage",), 1)
    try:
        if scenario.startswith("poll-"):
            value = await service.poll(row.id)
        else:
            await service.claim(
                account,
                PairingClaim(
                    code="123456",
                    connectorId="connector-synthetic",
                    connectorToken=None if scenario == "claim-token-missing" else "wrong-token",
                ),
            )
            raise AssertionError("本组领取反例不得成功")
        assert isinstance(value["serverTime"], str)
        value["serverTime"] = "<time>"
        observed: dict[str, object] = {"status": 200, "value": value}
    except DomainError as error:
        observed = {"status": error.status, "detail": error.detail}
        dao.save.assert_not_awaited()
    assert observed == pairing_oracle[SCENARIOS.index(scenario)]
    if scenario == "poll-claimed":
        assert row.encrypted_token is None and row.consumed_at is not None
        dao.save.assert_awaited_once_with(row)
    else:
        cipher.open.assert_not_called()
