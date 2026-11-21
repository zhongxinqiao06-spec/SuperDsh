"""供应商失败要可识别，同时禁止把签名地址和请求正文反射给前端。"""

import asyncio
import socket

import httpx
import pytest

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport


@pytest.mark.parametrize(
    "failure",
    [httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadError, httpx.WriteTimeout],
)
async def test_pinned_addresses_prefer_ipv4_and_only_retry_connect(
    monkeypatch: pytest.MonkeyPatch,
    failure: type[httpx.TransportError],
) -> None:
    # 受控 DNS 和传输层，不向实际供应商发送生成请求。
    async def resolve(*args: object, **kwargs: object) -> list[tuple]:
        return [
            (socket.AF_INET6, 1, 6, "", ("2001:db8::1", 443, 0, 0)),
            (socket.AF_INET, 1, 6, "", ("192.0.2.1", 443)),
            (socket.AF_INET, 1, 6, "", ("192.0.2.1", 443)),
        ]

    attempts: list[str] = []

    async def send(
        _: httpx.AsyncHTTPTransport, request: httpx.Request
    ) -> httpx.Response:
        attempts.append(request.url.host)
        assert (
            request.headers["host"]
            == request.extensions["sni_hostname"]
            == "fixture.invalid"
        )
        if len(attempts) == 1:
            raise failure("synthetic transport failure")
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolve)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", send)
    call = ProviderTransport("https://fixture.invalid").request(
        "POST", "https://fixture.invalid/job", {}, {}
    )
    if issubclass(failure, (httpx.ConnectError, httpx.ConnectTimeout)):
        assert await call == {"ok": True}
        assert attempts == ["192.0.2.1", "2001:db8::1"]
    else:
        with pytest.raises(DomainError):
            await call
        assert attempts == ["192.0.2.1"]


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
            lambda _: httpx.Response(
                400, json={"code": "https://private.invalid?token=secret"}
            )
        )
    )
    with pytest.raises(DomainError) as failure:
        await transport.request("POST", "https://fixture.invalid", {})
    assert (
        "secret" not in failure.value.detail and "private" not in failure.value.detail
    )
