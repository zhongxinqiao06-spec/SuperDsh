"""Loopback capability proxy: connector authentication, streaming, no provider keys."""

from __future__ import annotations

import asyncio
import hmac
import json
import re
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from urllib.parse import urlsplit

import httpx

MAX_REQUEST_BYTES = 32 * 1024 * 1024
MODEL_PATH = re.compile(
    r"^/scopes/([a-f0-9]{64})/providers/([A-Za-z0-9_-]+)/"
    r"(openai-completions|openai-responses|anthropic-messages)/"
    r"(chat/completions|responses|(?:v1/)?messages)$"
)
OPERATIONS = {
    "openai-completions": "chat/completions",
    "openai-responses": "responses",
    "anthropic-messages": "messages",
}


class ModelGateway:
    def __init__(
        self,
        *,
        server_url: str,
        secret: str,
        access_token: Callable[[], Awaitable[str]],
        ready: Callable[[], bool],
        port: int = 8790,
    ) -> None:
        self.server_url = server_url.rstrip("/")
        self.secret = secret
        self.access_token = access_token
        self.ready = ready
        self.port = port
        self.scope: str | None = None
        self.server: asyncio.Server | None = None
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(120, connect=15),
            follow_redirects=False,
            trust_env=False,
        )
        self.connections: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        self.server = await asyncio.start_server(
            self.handle, "127.0.0.1", self.port, limit=32 * 1024
        )
        self.port = self.server.sockets[0].getsockname()[1]

    async def close(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        for task in tuple(self.connections):
            task.cancel()
        await asyncio.gather(*self.connections, return_exceptions=True)
        await self.client.aclose()

    async def reply(
        self, writer: asyncio.StreamWriter, status: int, value: dict
    ) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        writer.write(
            f"HTTP/1.1 {status} {HTTPStatus(status).phrase}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n".encode()
            + body
        )
        await writer.drain()

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.current_task()
        if task:
            self.connections.add(task)
        try:
            await self.dispatch(reader, writer)
        except (asyncio.IncompleteReadError, ConnectionError, TimeoutError):
            pass
        except (ValueError, UnicodeError, asyncio.LimitOverrunError):
            await self.reply(writer, 400, {"error": "invalid request"})
        except httpx.HTTPError:
            await self.reply(writer, 502, {"error": "model service unavailable"})
        except Exception:  # noqa: BLE001 - authentication boundary must redact all upstream diagnostics
            # Never include upstream exception URLs, tokens, or vendor response bodies.
            await self.reply(writer, 503, {"error": "model authorization unavailable"})
        finally:
            if task:
                self.connections.discard(task)
            writer.close()
            await writer.wait_closed()

    async def dispatch(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
        lines = raw.decode("ascii").split("\r\n")
        method, target, version = lines[0].split(" ")
        if version != "HTTP/1.1" or len(raw) > 32 * 1024:
            raise ValueError("invalid HTTP request")
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if not line:
                continue
            name, value = line.split(":", 1)
            name = name.lower()
            if name in headers:
                raise ValueError("duplicate header")
            headers[name] = value.strip()
        path = urlsplit(target).path
        if method == "GET" and path == "/health":
            await self.reply(
                writer, 200 if self.ready() else 503, {"ready": self.ready()}
            )
            return
        authorization = headers.get("authorization")
        api_key = headers.get("x-api-key")
        # OpenAI sends Bearer; Anthropic sends x-api-key. Every supplied
        # credential must match the single fixed loopback capability.
        authorized = bool(authorization or api_key)
        if authorization is not None:
            authorized = (
                hmac.compare_digest(authorization, f"Bearer {self.secret}")
                and authorized
            )
        if api_key is not None:
            authorized = hmac.compare_digest(api_key, self.secret) and authorized
        if not authorized:
            await self.reply(writer, 401, {"error": "invalid capability"})
            return
        if method == "GET" and target == "/catalog":
            token = await self.access_token()
            response = await self.client.get(
                self.server_url + "/api/v2/connector/models/catalog",
                headers={"Authorization": f"Bearer {token}"},
            )
            if response.status_code != 200:
                await self.reply(
                    writer,
                    response.status_code if response.status_code in (401, 403) else 503,
                    {"error": "model catalog unavailable"},
                )
                return
            catalog = response.json()
            scope = catalog.get("scope")
            if not isinstance(scope, str) or not re.fullmatch(r"[a-f0-9]{64}", scope):
                raise ValueError("invalid model scope")
            self.scope = scope
            await self.reply(writer, 200, catalog)
            return
        match = MODEL_PATH.fullmatch(path)
        beta_query = bool(
            match
            and match.group(3) == "anthropic-messages"
            and target == path + "?beta=true"
        )
        if method != "POST" or not match or (target != path and not beta_query):
            await self.reply(writer, 404, {"error": "unknown model route"})
            return
        scope, provider, protocol, operation = match.groups()
        operation = operation.removeprefix("v1/")
        if scope != self.scope or OPERATIONS[protocol] != operation:
            await self.reply(
                writer, 403, {"error": "model route does not belong to this identity"}
            )
            return
        length = int(headers.get("content-length", "0"))
        if "transfer-encoding" in headers or not 0 < length <= MAX_REQUEST_BYTES:
            await self.reply(writer, 413, {"error": "invalid model request size"})
            return
        body = await asyncio.wait_for(reader.readexactly(length), 30)
        # Use only connector access credentials and a fixed product-owned origin.
        token = await self.access_token()
        url = f"{self.server_url}/api/v2/connector/models/{provider}/{protocol}/{operation}"
        upstream_headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        for name in ("anthropic-version", "anthropic-beta"):
            if name in headers:
                upstream_headers[name] = headers[name]
        disconnected = asyncio.create_task(reader.read(1))

        async def forward() -> None:
            async with self.client.stream(
                "POST", url, content=body, headers=upstream_headers
            ) as response:
                status = response.status_code
                writer.write(
                    f"HTTP/1.1 {status} {HTTPStatus(status).phrase}\r\n"
                    f"Content-Type: {response.headers.get('content-type', 'application/json')}\r\n"
                    "Transfer-Encoding: chunked\r\nCache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n".encode()
                )
                async for chunk in response.aiter_bytes():
                    if chunk:
                        writer.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                        await writer.drain()
                writer.write(b"0\r\n\r\n")
                await writer.drain()

        forwarding = asyncio.create_task(forward())
        try:
            done, _ = await asyncio.wait(
                (forwarding, disconnected), return_when=asyncio.FIRST_COMPLETED
            )
            if forwarding in done:
                await forwarding
            else:
                forwarding.cancel()
                await asyncio.gather(forwarding, return_exceptions=True)
        finally:
            disconnected.cancel()
            await asyncio.gather(disconnected, return_exceptions=True)
            if not forwarding.done():
                forwarding.cancel()
                await asyncio.gather(forwarding, return_exceptions=True)
