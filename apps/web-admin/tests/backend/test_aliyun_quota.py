"""隔离验证供应商模型凭据与 RAM 签名、零余额及只读权限失败的边界。"""

import json
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest

from app.infrastructure.errors import DomainError
from app.modules.models.service.aliyun_cli_install import install
from app.modules.models.service.aliyun_personal_usage import LOGIN_API, TOKEN_PATH, USAGE_API
from app.modules.models.service.aliyun_quota import HOST, PATH, read_quota
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.models.service.supplier_inspection import inspect_supplier

ORIGIN = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"


async def test_install_keeps_previous_session_until_ram_verified(tmp_path: Path) -> None:
    (tmp_path / "aliyun-token-plan.json").write_text(
        json.dumps(
            {
                "edition": "personal",
                "cliRamAccount": {"name": "tester", "userId": "22", "ownerId": "11"},
            }
        )
    )
    previous = tmp_path / "aliyun-personal-cli" / "config.json"
    previous.parent.mkdir()
    previous.write_text('{"access_token":"old"}')
    uid = "11"

    def identity(request: httpx.Request) -> httpx.Response:
        assert request.url.params["api"] == LOGIN_API
        return httpx.Response(200, json={"data": {"aliyun": {"uid": uid, "parentUid": "11"}}})

    transport = ProviderTransport(transport=httpx.MockTransport(identity))
    profile = {"access_token": "new", "api_key": "ordinary", "access_key_secret": "extra"}
    with pytest.raises(DomainError, match="身份与绑定的 RAM 账号不符"):
        await install(tmp_path, profile, transport)
    assert json.loads(previous.read_text()) == {"access_token": "old"}
    uid = "22"
    await install(tmp_path, profile, transport)
    assert json.loads(previous.read_text()) == {"access_token": "new"}


@pytest.mark.parametrize("state", ["missing", "owner", "other", "expired", "ok", "denied"])
async def test_bound_cli_verifies_ram_before_reading_usage(tmp_path: Path, state: str) -> None:
    config = tmp_path / "quota.json"
    config.write_text(
        json.dumps(
            {
                "connectionId": "plan",
                "edition": "personal",
                "cliRamAccount": {"name": "tester", "userId": "22", "ownerId": "11"},
            }
        )
    )
    if state != "missing":
        directory = tmp_path / "aliyun-personal-cli"
        directory.mkdir()
        (directory / "config.json").write_text(
            json.dumps(
                {
                    "access_token": "fixture-console",
                    "api_key": "fixture-ordinary",
                    "console_switch_agent": "42",
                }
            )
        )
    calls = []

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "bailian-cs.console.aliyun.com"
        assert request.headers["authorization"] == "Bearer fixture-console"
        payload = json.loads(parse_qs(request.content.decode())["params"][0])
        assert payload["Data"]["cornerstoneParam"]["switchAgent"] == 42
        assert "fixture-ordinary" not in request.content.decode()
        api = request.url.params["api"]
        calls.append(api)
        if api == LOGIN_API:
            if state == "expired":
                return httpx.Response(401)
            uid = "11" if state == "owner" else "33" if state == "other" else "22"
            return httpx.Response(
                200,
                json={
                    "data": {
                        "success": True,
                        "DataV2": {"data": {"data": {"aliyun": {"uid": uid, "parentUid": "11"}}}},
                    }
                },
            )
        assert api == USAGE_API and state in ("ok", "denied")
        if state == "denied":
            return httpx.Response(
                200,
                json={"data": {"success": False, "errorCode": "BailianGateway.Team.NotAuthorised"}},
            )
        return httpx.Response(
            200, json={"data": {"per1MonthPercentage": 0, "per1MonthResetTime": 1800000000000}}
        )

    result = await read_quota(
        ProviderTransport(transport=httpx.MockTransport(respond)), config, "plan"
    )
    verified = state in ("ok", "denied")
    assert calls == (
        [LOGIN_API, USAGE_API] if verified else [] if state == "missing" else [LOGIN_API]
    )
    assert result["cliRamAccount"] == {
        "name": "tester",
        "loginName": "tester@11.onaliyun.com",
        "verified": verified,
    }
    assert result["personalUsage"] == (
        {"usedRatio": 0, "resetAtMs": 1800000000000}
        if state == "ok"
        else {"usedRatio": None, "resetAtMs": None}
    )
    assert bool(result["quotaError"]) == (state != "ok")
    assert "fixture" not in json.dumps(result)


@pytest.mark.parametrize("status", [200, 403])
async def test_catalog_and_quota_use_separate_credentials(tmp_path: Path, status: int) -> None:
    config = tmp_path / "credentials.json"
    config.write_text(
        json.dumps(
            {
                "connectionId": "plan",
                "accessKeyId": "fixture-id",
                "accessKeySecret": "fixture-secret",
            }
        )
    )
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        assert request.method == "GET" and not request.content
        if request.url.host == HOST:
            assert request.url.path == PATH
            assert request.headers["x-acs-action"] == "GetSubscriptionStats"
            assert request.headers["Authorization"].startswith(
                "ACS3-HMAC-SHA256 Credential=fixture-id,"
            )
            assert "fixture-secret" not in str(request.headers.raw) and "model-token" not in str(
                request.headers.raw
            )
            return httpx.Response(
                status,
                json={
                    "Success": True,
                    "Data": {
                        "Items": [
                            {"SeatType": "pro", "SeatCredits": 300, "SeatRemainingCredits": 0}
                        ]
                    },
                },
            )
        assert (
            request.url == ORIGIN + "/models"
            and request.headers["Authorization"] == "Bearer model-token"
        )
        assert "x-acs-action" not in request.headers
        return httpx.Response(200, json={"data": [{"id": "upstream-model"}]})

    transport = ProviderTransport(transport=httpx.MockTransport(upstream))
    result = await inspect_supplier(
        transport,
        ORIGIN,
        "openai-completions",
        "model-token",
        connection_id="plan",
        quota_file=config,
    )
    assert len(calls) == 2 and result["models"] == ["upstream-model"] and not result["modelError"]
    if status == 200:
        assert (
            result["quotaItems"] == [{"type": "pro", "quota": 300, "remaining": 0}]
            and not result["quotaError"]
        )
    else:
        assert result["quotaItems"] == [] and "modelstudio:GetSubscriptionStats" in str(
            result["quotaError"]
        )
    calls.clear()
    other = await inspect_supplier(
        transport,
        ORIGIN,
        "openai-completions",
        "model-token",
        connection_id="other-connection",
        quota_file=config,
    )
    assert calls == ["token-plan.cn-beijing.maas.aliyuncs.com"] and other["quotaItems"] == []


@pytest.mark.parametrize(
    "payload,ratio,reset,denied",
    [
        ({"per1MonthPercentage": 0, "per1MonthResetTime": 1800000000000}, 0, 1800000000000, False),
        ({"per1MonthPercentage": 0.1275}, 0.1275, None, False),
        ({"per1MonthPercentage": True, "per1MonthResetTime": 0}, None, None, False),
        ({"per1MonthResetTime": 1800000000000}, None, 1800000000000, False),
        ({"success": False, "errorCode": "BailianGateway.Team.NotAuthorised"}, None, None, True),
    ],
)
async def test_aliyun_personal_monthly_usage(
    tmp_path: Path, payload: dict[str, object], ratio: float | None, reset: int | None, denied: bool
) -> None:
    config = tmp_path / "personal.json"
    config.write_text(
        json.dumps(
            {
                "connectionId": "plan",
                "edition": "personal",
                "accessKeyId": "fixture-id",
                "accessKeySecret": "fixture-secret",
            }
        )
    )

    def upstream(request: httpx.Request) -> httpx.Response:
        if request.url.host == HOST:
            assert (
                request.method == "POST" and request.url.path == TOKEN_PATH and not request.content
            )
            assert request.headers["x-acs-action"] == "GenerateCLIAccessToken"
            return httpx.Response(200, json={"cliAccessToken": "fixture-cli-token"})
        if request.url.host == "bailian-cs.console.aliyun.com":
            assert request.method == "POST" and request.url.params["api"] == USAGE_API
            assert request.headers["Authorization"] == "Bearer fixture-cli-token"
            assert request.headers["content-type"] == "application/x-www-form-urlencoded"
            form = parse_qs(request.content.decode())
            assert (
                form["region"] == ["cn-beijing"]
                and json.loads(form["params"][0])["Api"] == USAGE_API
            )
            return httpx.Response(
                200, json={"successResponse": True, "data": {"DataV2": {"data": payload}}}
            )
        assert (
            request.url == ORIGIN + "/models"
            and request.headers["Authorization"] == "Bearer model-token"
        )
        return httpx.Response(200, json={"data": [{"id": "upstream-model"}]})

    result = await inspect_supplier(
        ProviderTransport(transport=httpx.MockTransport(upstream)),
        ORIGIN,
        "openai-completions",
        "model-token",
        connection_id="plan",
        quota_file=config,
    )
    assert result["models"] == ["upstream-model"] and result["quotaItems"] == []
    assert result["personalUsage"] == {"usedRatio": ratio, "resetAtMs": reset}
    assert bool(result["quotaError"]) is denied and "fixture" not in json.dumps(result)
