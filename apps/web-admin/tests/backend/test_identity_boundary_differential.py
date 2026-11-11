"""对照旧真实身份处理器的具体边界，不把普通成功用例当作所有Schema约束证据。"""

import json
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qsl

import pytest

from app.infrastructure.errors import DomainError
from app.infrastructure.query_parameters import query_integer
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.validation import account_username, collision_username
from app.modules.identity.entity.vo.account_vo import AvatarInput, EmailCodeInput
from app.modules.identity.entity.vo.dto import UserCreateInput, UserPatchInput
from app.modules.identity.entity.vo.oauth import AuthorizeInput
from app.modules.identity.service.account_service import AccountFlows
from app.modules.identity.service.identity import IdentityService
from app.modules.identity.service.oauth import OAuthService

ROOT = Path(__file__).resolve().parents[4]
ACCOUNT = Account("synthetic-user", "synthetic", ("admin",), (), 0)
_CASE_VALUES = (
    [
        {"kind": "avatar", "body": {"avatar": value}}
        for value in (
            " data:image/png;base64,aGVsbG8= \n",
            "data:image/png;base64," + "A" * (256 * 1024),
            "data:text/html;base64,YQ==",
            None,
        )
    ]
    + [
        {"kind": "username", "body": {"displayName": "Synthetic", **body}, "collision": collision}
        for body, collision in (
            ({"email": "User.Name@example.invalid"}, False),
            ({"email": "a@example.invalid"}, False),
            ({"email": "synthetic@example.invalid"}, True),
            ({"username": " Explicit-User ", "email": "synthetic@example.invalid"}, True),
            ({"username": ""}, False),
            ({"username": "invalid user"}, False),
        )
    ]
    + [
        {"kind": "password-patch", "body": {field: value}}
        for field in ("password", "passwordVerifier", "passwordSalt")
        for value in (None, "synthetic-value")
    ]
    + [
        {"kind": kind, "query": query, "fallback": fallback}
        for kind, fallback in (("page", 50), ("page", 200), ("session-page", 200))
        for query in (
            "",
            "page=&pageSize=",
            "page=0x2&pageSize=2e1&search=%20Mixed%20",
            "page=1.0&pageSize=200",
            "page=0&pageSize=1",
            "pageSize=201",
            "page=9007199254740992",
        )
    ]
    + [
        {
            "kind": "email-code",
            "users": users,
            "body": {
                "email": "synthetic@example.invalid",
                "purpose": "register",
                "setupToken": token,
            },
        }
        for users, token in ((0, "synthetic-setup"), (0, "invalid"), (1, "synthetic-setup"))
    ]
    + [
        {
            "kind": "authorize",
            "body": {
                "client_id": "agents-anywhere-mobile",
                "redirect_uri": "agents-anywhere://oauth/callback",
                "code_challenge": "a" * 43,
                **body,
            },
        }
        for body in (
            {},
            {"response_type": "token"},
            {
                "response_type": "code",
                "redirect_uri": "https://evil.invalid",
                "code_challenge": "bad",
            },
            {"response_type": "code", "code_challenge_method": "plain"},
        )
    ]
)


CASES: list[dict[str, object]] = [dict[str, object](value) for value in _CASE_VALUES]


@pytest.fixture(scope="module")
def boundary_expected() -> list[dict[str, object]]:
    """每轮加载冻结旧源码，数据库和邮件端口只提供明确的合成状态。"""
    result = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/identity-boundary-oracle.ts")],
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


async def issue_email(case: dict[str, object], body: dict[str, object]) -> dict[str, object]:
    """调用实际邮箱注册门禁，仅存储和发信隔离，确认已有用户无法借token开放注册。"""
    transaction = AsyncMock()
    transaction.users.return_value = [object()] if case["users"] else []

    @asynccontextmanager
    async def context() -> AsyncIterator[AsyncMock]:
        yield transaction

    identity = IdentityService(
        Mock(transaction=context),
        Mock(),
        "synthetic-setup",
        datetime(2030, 1, 1, tzinfo=UTC),
    )
    flows = AccountFlows.__new__(AccountFlows)
    flows.identity = identity
    flows.system = Mock(internal_settings=AsyncMock(return_value={}))
    flows.repository = Mock(sessions=context, user=AsyncMock(return_value=None))
    flows.email = Mock(issue=AsyncMock())
    flows.external = Mock(pending=AsyncMock())
    await flows.issue_email(EmailCodeInput.model_validate(body), None)
    flows.email.issue.assert_awaited_once()
    return {"accepted": True}


@pytest.mark.parametrize("index", range(len(CASES)))
async def test_identity_observed_boundary_matches_old_handler(
    index: int, boundary_expected: list[dict[str, object]]
) -> None:
    case = CASES[index]
    raw = cast(dict[str, object], case.get("body", {}))
    try:
        if case["kind"] == "avatar":
            value: object = {"avatar": AvatarInput.model_validate(raw).avatar}
        elif case["kind"] == "username":
            body = UserCreateInput.model_validate(raw)
            username = account_username(body.username, body.email)
            if not body.username and body.email and case["collision"]:
                username = collision_username(username, body.email)
            value = {"username": username}
        elif case["kind"] == "password-patch":
            UserPatchInput.model_validate(raw)
            raise AssertionError("password mutation must not reach storage")
        elif case["kind"] in {"page", "session-page"}:
            query = dict(parse_qsl(str(case["query"]), keep_blank_values=True))
            search = query.get("search", "").lower()
            value = {
                "page": query_integer(query.get("page"), 1, 1),
                "pageSize": query_integer(
                    query.get("pageSize"), int(str(case["fallback"])), 1, 200
                ),
                "search": search.strip() if case["kind"] == "page" else search,
            }
        elif case["kind"] == "email-code":
            value = await issue_email(case, raw)
        else:
            authorize = AuthorizeInput.model_validate(raw)
            oauth = OAuthService.__new__(OAuthService)
            value = await oauth.authorize(
                ACCOUNT,
                authorize.client_id,
                authorize.redirect_uri,
                authorize.code_challenge,
                authorize.code_challenge_method,
                authorize.response_type,
                authorize.state,
                authorize.scope,
            )
        observed = {"status": 200, "body": value}
    except DomainError as error:
        observed = {"status": error.status, "body": {"detail": error.detail}}
    assert observed == boundary_expected[index], case
