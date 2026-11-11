"""输入边界使用旧真实校验/handler差分，并确保仅登录DTO忽略无关扩展字段。"""

import json
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.vo.account_vo import ProfileInput
from app.modules.identity.entity.vo.dto import LoginInput, PasswordSaltInput, RoleInput
from app.modules.identity.service.identity import IdentityService

ROOT = Path(__file__).resolve().parents[4]
CASES: list[dict[str, object]] = [
    dict[str, object](kind="display", value=value)
    for value in (
        " 合成名称 ",
        " ",
        None,
        3,
        "a" * 65,
        "a" * 64,
        "😀" * 32,
        "😀" * 33,
        "name\x00test",
        "\n Trim \t",
    )
] + [
    dict[str, object](kind=kind, body=body)
    for kind in ("login", "password-salt")
    for body in (
        {},
        {"identifier": None},
        {"identifier": 123},
        {"identifier": "absent", "extension": {"role": "admin"}},
        {"identifier": "a" * 320, "password": None},
        {"identifier": "invalid@@email"},
        {"email": " Bad@Example.Invalid ", "password": 123},
        {"identifier": "absent", "password": "a" * 1100, "passwordVerifier": "a" * 200},
    )
]


@pytest.fixture(scope="module")
def expected_inputs() -> list[dict[str, object]]:
    result = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/identity-input-oracle.ts")],
        input=json.dumps(CASES),
        text=True,
        encoding="utf-8",
        capture_output=True,
        cwd=ROOT,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return cast(list[dict[str, object]], json.loads(result.stdout))


@pytest.mark.parametrize("index", range(len(CASES)))
async def test_input_matches_legacy(index: int, expected_inputs: list[dict[str, object]]) -> None:
    """密码挑战只比较是否返回有效非空盐，随机值及时间不参与等值判断。"""
    case, expected = CASES[index], expected_inputs[index]
    tx = AsyncMock()
    tx.find_user.return_value = None

    @asynccontextmanager
    async def transaction() -> AsyncIterator[AsyncMock]:
        yield tx

    identity = IdentityService.__new__(IdentityService)
    identity.repository = Mock(transaction=transaction)
    try:
        if case["kind"] == "display":
            body: dict[str, object] = {
                "displayName": ProfileInput.model_validate(
                    {"displayName": case["value"]}
                ).displayName
            }
        elif case["kind"] == "password-salt":
            salt = PasswordSaltInput.model_validate(case["body"])
            result = await identity.password_salt(salt.identifier or salt.email)
            assert result
            body = {"salt": True}
        else:
            login = LoginInput.model_validate(case["body"])
            assert "extension" not in login.model_dump()
            await identity.login(
                login.identifier or login.email,
                login.password,
                login.passwordVerifier,
                login.clientName,
            )
            raise AssertionError("synthetic empty store cannot authenticate")
        observed = {"status": 200, "body": body}
    except DomainError as error:
        observed = {"status": error.status, "body": {"detail": error.detail}}
    if case["kind"] == "password-salt" and expected["status"] == 200:
        assert cast(dict[str, object], expected["body"])["salt"]
        expected = {"status": 200, "body": {"salt": True}}
    assert observed == expected, case


def test_non_login_write_dto_still_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        RoleInput.model_validate({"name": "角色", "permissions": [], "builtin": True})
