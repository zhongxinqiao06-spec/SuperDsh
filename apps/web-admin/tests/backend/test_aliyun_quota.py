"""隔离验证供应商模型凭据与 RAM 签名、零余额及只读权限失败的边界。"""

import json
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest

from app.modules.models.service.aliyun_personal_usage import TOKEN_PATH, USAGE_API
from app.modules.models.service.aliyun_quota import HOST, PATH
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.models.service.supplier_inspection import inspect_supplier

ORIGIN = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"


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
