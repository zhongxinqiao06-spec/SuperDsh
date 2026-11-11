"""供应商 HTTP 边界：解析并固定目标 IP、禁止重定向、限制等待与响应体。"""

import asyncio
import ipaddress
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import httpx

from app.infrastructure.errors import DomainError


class ProviderTransport:
    """生产请求仅访问解析校验后的地址；测试可注入独立的 HTTP transport。"""

    def __init__(
        self, allowed_origins: str = "", transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.allowed_origins = {
            item.strip().rstrip("/") for item in allowed_origins.split(",") if item.strip()
        }
        self.transport = transport

    async def _target(
        self, url: str, headers: dict[str, str]
    ) -> tuple[httpx.URL, dict[str, str], dict[str, object]]:
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
        ):
            raise DomainError(422, "供应商地址无效")
        hostname = parsed.hostname or ""
        origin = f"{parsed.scheme}://{parsed.netloc}"
        requested = httpx.URL(url)
        extensions: dict[str, object] = {}
        if self.transport is None:
            try:
                addresses = await asyncio.wait_for(
                    asyncio.get_running_loop().getaddrinfo(
                        hostname,
                        parsed.port or (443 if parsed.scheme == "https" else 80),
                        type=socket.SOCK_STREAM,
                    ),
                    5,
                )
            except (OSError, TimeoutError) as error:
                raise DomainError(502, "供应商地址解析失败") from error
            values = {str(item[4][0]) for item in addresses}
            if not values or (
                origin not in self.allowed_origins
                and any(not ipaddress.ip_address(value).is_global for value in values)
            ):
                raise DomainError(403, "供应商地址不在允许访问的范围")
            # URL 改为已经校验的 IP，Host/SNI 保留原站点，避免第二次 DNS 解析改变目标。
            requested = requested.copy_with(host=sorted(values)[0])
            headers = {**headers, "Host": parsed.netloc}
            extensions["sni_hostname"] = hostname
        return requested, headers, extensions

    @asynccontextmanager
    async def open_stream(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, object] | None = None,
        *,
        preserve_status: bool = False,
    ) -> AsyncIterator[httpx.Response]:
        """流式响应同样固定DNS和拒绝重定向，取消立即关闭供应商连接。"""
        requested, headers, extensions = await self._target(url, headers)
        try:
            async with httpx.AsyncClient(
                transport=self.transport,
                timeout=httpx.Timeout(60, connect=10),
                follow_redirects=False,
                trust_env=False,
            ) as client:
                async with client.stream(
                    method, requested, headers=headers, json=body, extensions=extensions
                ) as response:
                    if not 200 <= response.status_code < 300:
                        raise DomainError(
                            response.status_code
                            if preserve_status and 400 <= response.status_code < 600
                            else 422
                            if response.status_code < 500
                            else 502,
                            "供应商拒绝请求，请检查地址、凭据和模型",
                        )
                    yield response
        except httpx.TimeoutException as error:
            raise DomainError(504, "供应商连接超时") from error
        except (httpx.HTTPError, ValueError) as error:
            raise DomainError(502, "供应商连接失败") from error

    async def request(
        self, method: str, url: str, headers: dict[str, str], body: dict[str, object] | None = None
    ) -> dict[str, object]:
        """非流式结果在相同网络边界内有界收集，不反射供应商错误正文。"""
        async with self.open_stream(method, url, headers, body) as response:
            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > 16 * 1024 * 1024:
                    raise DomainError(502, "供应商返回的数据过大")
            value = httpx.Response(200, content=bytes(content)).json()
            if not isinstance(value, dict):
                raise DomainError(502, "供应商响应格式无效")
            return dict(value)
