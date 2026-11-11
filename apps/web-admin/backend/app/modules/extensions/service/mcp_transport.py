"""MCP HTTP 请求限制为已配置端点，并固定解析地址，凭据不能随重定向外传。"""

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

import httpx2

from app.infrastructure.errors import DomainError


class EndpointTransport(httpx2.AsyncBaseTransport):
    """SDK 的全部请求经过同一端点检查；不继承系统代理和 Cookie。"""

    def __init__(self, endpoint: str, allowed_origins: str) -> None:
        self.endpoint = httpx2.URL(endpoint)
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
        ):
            raise DomainError(422, "MCP地址必须是完整HTTP端点且不能包含凭据或片段")
        self.allowed = {
            item.strip().rstrip("/") for item in allowed_origins.split(",") if item.strip()
        }
        self.inner = httpx2.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        """每次发送都校验目标，禁止 SDK 同源重定向改变配置路径。"""
        if request.url != self.endpoint:
            raise DomainError(403, "MCP请求越出已配置端点")
        host = request.url.host
        port = request.url.port or (443 if request.url.scheme == "https" else 80)
        try:
            records = await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM), 5
            )
        except (OSError, TimeoutError) as error:
            raise DomainError(502, "MCP地址解析失败") from error
        addresses = {str(item[4][0]) for item in records}
        parsed = urlsplit(str(self.endpoint))
        if not addresses or (
            f"{parsed.scheme}://{parsed.netloc}" not in self.allowed
            and any(not ipaddress.ip_address(address).is_global for address in addresses)
        ):
            raise DomainError(403, "MCP地址不在允许访问的范围")
        request.headers["Host"] = parsed.netloc
        request.extensions["sni_hostname"] = host
        request.url = request.url.copy_with(host=sorted(addresses)[0])
        response = await self.inner.handle_async_request(request)
        if 300 <= response.status_code < 400:
            await response.aclose()
            raise DomainError(403, "MCP端点不允许重定向")
        return response

    async def aclose(self) -> None:
        """随每次会话释放底层连接池。"""
        await self.inner.aclose()
