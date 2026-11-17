"""供应商 HTTP 边界：解析并固定目标 IP、禁止重定向、限制等待与响应体。"""

import asyncio
import ipaddress
import json
import re
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import httpx

from app.infrastructure.errors import DomainError

PROXY_DNS_RANGES = (ipaddress.ip_network("198.18.0.0/15"), ipaddress.ip_network("2001:2::/48"))


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
        self, url: str, headers: dict[str, str], *, allow_proxy_dns: bool = False
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
                and any(
                    not ipaddress.ip_address(value).is_global
                    and not (
                        allow_proxy_dns
                        and any(
                            ipaddress.ip_address(value) in subnet for subnet in PROXY_DNS_RANGES
                        )
                    )
                    for value in values
                )
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
        allow_proxy_dns: bool = False,
        read_timeout: float = 60,
    ) -> AsyncIterator[httpx.Response]:
        """流式响应同样固定DNS和拒绝重定向，取消立即关闭供应商连接。"""
        if not 1 <= read_timeout <= 240:
            raise DomainError(422, "供应商读取等待时间超出允许范围")
        requested, headers, extensions = await self._target(
            url, headers, allow_proxy_dns=allow_proxy_dns
        )
        try:
            async with httpx.AsyncClient(
                transport=self.transport,
                timeout=httpx.Timeout(60, connect=10, read=read_timeout),
                follow_redirects=False,
                trust_env=False,
            ) as client:
                async with client.stream(
                    method, requested, headers=headers, json=body, extensions=extensions
                ) as response:
                    if not 200 <= response.status_code < 300:
                        # 只保留受限错误标识，不反射可能夹带签名 URL、请求内容或密钥的错误正文。
                        error_content = bytearray()
                        async for chunk in response.aiter_bytes():
                            error_content.extend(chunk[: 8192 - len(error_content)])
                            if len(error_content) >= 8192:
                                break
                        provider_code = ""
                        try:
                            value = json.loads(error_content)
                            error = value.get("error", value) if isinstance(value, dict) else {}
                            candidate = error.get("code", "") if isinstance(error, dict) else ""
                            if isinstance(candidate, str) and re.fullmatch(
                                r"[A-Za-z][A-Za-z0-9_.-]{0,99}", candidate
                            ):
                                provider_code = " · " + candidate
                        except (ValueError, UnicodeError):
                            pass
                        detail = (
                            "供应商未通过图片内容审核，请调整画面内容或使用已有素材"
                            if "SensitiveContentDetected" in provider_code
                            else "供应商请求过于频繁，请稍后重试"
                            if response.status_code == 429
                            else "供应商拒绝请求，请检查地址、凭据和模型"
                        )
                        raise DomainError(
                            response.status_code
                            if preserve_status and 400 <= response.status_code < 600
                            else 422
                            if response.status_code < 500
                            else 502,
                            f"{detail}（HTTP {response.status_code}{provider_code}）",
                            f"provider_http_{response.status_code}",
                        )
                    yield response
        except httpx.ReadTimeout as error:
            raise DomainError(504, "等待供应商响应超时", "provider_read_timeout") from error
        except httpx.ConnectTimeout as error:
            raise DomainError(504, "建立供应商网络连接超时", "provider_connect_timeout") from error
        except httpx.WriteTimeout as error:
            raise DomainError(504, "向供应商发送请求超时", "provider_write_timeout") from error
        except httpx.TimeoutException as error:
            raise DomainError(504, "等待供应商连接可用超时", "provider_pool_timeout") from error
        except (httpx.HTTPError, ValueError) as error:
            raise DomainError(502, "供应商连接失败") from error

    async def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, object] | None = None,
        *,
        read_timeout: float = 60,
    ) -> dict[str, object]:
        """非流式结果在相同网络边界内有界收集，不反射供应商错误正文。"""
        async with self.open_stream(
            method, url, headers, body, read_timeout=read_timeout
        ) as response:
            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > 16 * 1024 * 1024:
                    raise DomainError(502, "供应商返回的数据过大")
            value = httpx.Response(200, content=bytes(content)).json()
            if not isinstance(value, dict):
                raise DomainError(502, "供应商响应格式无效")
            return dict(value)
