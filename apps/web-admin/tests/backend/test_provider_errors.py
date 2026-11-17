"""供应商失败要可识别，同时禁止把签名地址和请求正文反射给前端。"""

import httpx
import pytest

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport


@pytest.mark.parametrize(
    "status,code,hint",
    [
        (400, "OutputImageSensitiveContentDetected.PolicyViolation", "图片内容审核"),
        (429, "RateLimitExceeded", "过于频繁"),
        (400, "InvalidParameter", "检查地址"),
    ],
)
async def test_provider_error_retains_only_safe_identifier(
    status: int, code: str, hint: str
) -> None:
    def reject(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            json={
                "error": {
                    "code": code,
                    "message": "https://private.invalid?token=private-synthetic-value",
                }
            },
        )

    transport = ProviderTransport(transport=httpx.MockTransport(reject))
    with pytest.raises(DomainError) as failure:
        await transport.request("POST", "https://fixture.invalid", {})
    assert hint in failure.value.detail and code in failure.value.detail
    assert "private" not in failure.value.detail


async def test_provider_error_rejects_untrusted_error_code() -> None:
    transport = ProviderTransport(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(400, json={"code": "https://private.invalid?token=secret"})
        )
    )
    with pytest.raises(DomainError) as failure:
        await transport.request("POST", "https://fixture.invalid", {})
    assert "secret" not in failure.value.detail and "private" not in failure.value.detail
