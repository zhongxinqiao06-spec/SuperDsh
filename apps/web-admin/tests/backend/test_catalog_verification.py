"""供应商只读检测回归：全部使用合成地址和 MockTransport，不调用外部模型。"""

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest

from app.infrastructure.errors import DomainError
from app.modules.models.service.catalog_verification import verify_model_catalog
from app.modules.models.service.provider_transport import ProviderTransport

CATALOG_URL = "https://models.synthetic.invalid/plan/models"


@pytest.mark.parametrize("status", [200, 404, 405])
async def test_catalog_result_never_generates_or_infers_credentials(status: int) -> None:
    """空目录可访问与目录缺失分别报告；所有路径都只执行一次无正文 GET。"""
    requests: list[httpx.Request] = []

    def reply(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return (
            httpx.Response(status, json={"data": []}) if status == 200 else httpx.Response(status)
        )

    result = await verify_model_catalog(
        ProviderTransport(transport=httpx.MockTransport(reply)),
        CATALOG_URL,
        {"Authorization": "Bearer synthetic-key"},
    )
    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert str(requests[0].url) == CATALOG_URL
    assert requests[0].content == b""
    assert requests[0].headers["authorization"] == "Bearer synthetic-key"
    assert "未发起模型生成" in result.message
    assert "synthetic-key" not in result.model_dump_json()
    assert result.serverTime
    if status == 200:
        assert result.ok is True and result.status == "verified"
        assert "具体模型调用能力尚未验证" in result.message
    else:
        assert result.ok is False and result.status == "unverified"
        assert f"HTTP {status}" in result.message
        assert "无法通过只读检测确认" in result.message


@pytest.mark.parametrize("status,expected", [(401, 422), (403, 403), (429, 429), (500, 500)])
async def test_rejected_catalog_is_an_error_without_echoing_body(
    status: int, expected: int
) -> None:
    """鉴权和服务故障保留失败语义，上游 401 不冒充平台登录失效。"""
    transport = ProviderTransport(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(status, text="private-upstream-body")
        )
    )
    with pytest.raises(DomainError) as captured:
        await verify_model_catalog(transport, CATALOG_URL, {})
    assert captured.value.status == expected
    assert "private-upstream-body" not in captured.value.detail
    if status == 401:
        assert captured.value.code == "model_catalog_rejected"


@pytest.mark.parametrize("body", [b"", b"<html>login</html>", b"[]", b"{}", b'{"data":{}}'])
async def test_success_status_requires_a_model_catalog(body: bytes) -> None:
    """反向代理登录页或非目录 JSON 不能显示为检测通过。"""
    transport = ProviderTransport(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body))
    )
    with pytest.raises(DomainError, match="模型目录格式无效") as captured:
        await verify_model_catalog(transport, CATALOG_URL, {})
    assert captured.value.status == 502


async def test_catalog_timeout_has_no_generation_fallback() -> None:
    requests: list[httpx.Request] = []

    def timeout(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    with pytest.raises(DomainError) as captured:
        await verify_model_catalog(
            ProviderTransport(transport=httpx.MockTransport(timeout)), CATALOG_URL, {}
        )
    assert captured.value.status == 504
    assert [request.method for request in requests] == ["GET"]


async def test_catalog_cancellation_propagates_and_releases_request() -> None:
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def pending(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
        raise AssertionError("取消后的请求不能继续")

    task = asyncio.create_task(
        verify_model_catalog(
            ProviderTransport(transport=httpx.MockTransport(pending)), CATALOG_URL, {}
        )
    )
    try:
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cancelled.is_set()
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def test_catalog_body_limit_closes_stream() -> None:
    closed = False

    class OversizedCatalog(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            for _ in range(17):
                yield b"x" * (1024 * 1024)

        async def aclose(self) -> None:
            nonlocal closed
            closed = True

    transport = ProviderTransport(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=OversizedCatalog()))
    )
    with pytest.raises(DomainError, match="模型目录数据过大"):
        await verify_model_catalog(transport, CATALOG_URL, {})
    assert closed
