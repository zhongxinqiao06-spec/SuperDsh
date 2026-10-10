"""Pin personal-provider requests to validated DNS results, keeping Host and TLS SNI."""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from collections.abc import Awaitable, Callable, Sequence

import httpx

from agent_server.services.platform_models import ModelConfigurationError

Resolver = Callable[[str, int], Awaitable[Sequence[str]]]


async def resolve_addresses(host: str, port: int) -> Sequence[str]:
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        records = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM),
            timeout=5,
        )
        return tuple(dict.fromkeys(record[4][0] for record in records))
    return (str(literal),)


def origin(url: httpx.URL) -> tuple[str, str, int]:
    if (
        url.scheme not in {"http", "https"}
        or not url.host
        or url.userinfo
        or url.query
        or url.fragment
    ):
        raise ModelConfigurationError("personal model address is invalid")
    port = url.port if url.port is not None else (443 if url.scheme == "https" else 80)
    if not 1 <= port <= 65535:
        raise ModelConfigurationError("personal model address is invalid")
    return (url.scheme, url.host, port)


def allowed_origins() -> set[tuple[str, str, int]]:
    allowed = set()
    for value in os.environ.get("SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS", "").split(
        ","
    ):
        if not value.strip():
            continue
        try:
            url = httpx.URL(value.strip())
            if url.path not in {"", "/"}:
                raise ValueError
            allowed.add(origin(url))
        except (ValueError, httpx.InvalidURL) as exc:
            raise ModelConfigurationError(
                "personal model network allowlist is invalid"
            ) from exc
    return allowed


def public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if not address.is_global or address.is_multicast or address.is_unspecified:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        return not address.scope_id and (
            address.ipv4_mapped is None or public_address(address.ipv4_mapped)
        )
    return True


async def personal_model_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    content: bytes | None = None,
    resolver: Resolver = resolve_addresses,
) -> httpx.Request:
    try:
        original = httpx.URL(url)
        requested_origin = origin(original)
        addresses = await resolver(requested_origin[1], requested_origin[2])
        parsed = [ipaddress.ip_address(address) for address in addresses]
    except ModelConfigurationError:
        raise
    except (ValueError, OSError, TimeoutError, httpx.InvalidURL) as exc:
        raise ModelConfigurationError(
            "personal model address cannot be resolved"
        ) from exc
    if not parsed:
        raise ModelConfigurationError("personal model address cannot be resolved")
    explicitly_allowed = requested_origin in allowed_origins()
    if not explicitly_allowed and any(
        not public_address(address) for address in parsed
    ):
        raise ModelConfigurationError(
            "personal model address must resolve only to public addresses; "
            "self-hosted endpoints require an administrator origin allowlist"
        )
    # Connect to this literal IP, never resolve the user-controlled name a
    # second time. The original authority is still used for HTTP and TLS.
    pinned = original.copy_with(host=str(parsed[0]))
    safe_headers = {**headers, "Host": original.netloc.decode("ascii")}
    return client.build_request(
        method,
        pinned,
        headers=safe_headers,
        content=content,
        extensions={"sni_hostname": original.raw_host.decode("ascii")},
    )
