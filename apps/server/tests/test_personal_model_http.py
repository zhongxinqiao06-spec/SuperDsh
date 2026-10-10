from __future__ import annotations

import asyncio

import httpx
import pytest

from agent_server.services.personal_model_http import personal_model_request
from agent_server.services.platform_models import ModelConfigurationError


@pytest.mark.parametrize(
    "addresses",
    [
        ["127.0.0.1"],
        ["::1"],
        ["10.0.0.1"],
        ["169.254.169.254"],
        ["::ffff:127.0.0.1"],
        ["100.64.0.1"],
        ["224.0.0.1"],
        ["0.0.0.0"],
        ["8.8.8.8", "192.168.1.1"],
        [],
    ],
)
def test_personal_requests_reject_nonpublic_or_mixed_dns(addresses, monkeypatch):
    monkeypatch.delenv("SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS", raising=False)

    async def dns(host, port):
        return addresses

    async def build():
        async with httpx.AsyncClient() as client:
            return await personal_model_request(
                client,
                "GET",
                "https://model.example/v1/models",
                headers={},
                resolver=dns,
            )

    with pytest.raises(ModelConfigurationError):
        asyncio.run(build())


def test_public_request_pins_ip_but_keeps_host_and_sni(monkeypatch):
    monkeypatch.delenv("SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS", raising=False)
    observed = []
    dns_calls = []

    async def dns(host, port):
        dns_calls.append((host, port))
        # A second resolution would rebind to a private address.
        return ["8.8.8.8"] if len(dns_calls) == 1 else ["127.0.0.1"]

    async def send():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: observed.append(request) or httpx.Response(200)
            )
        ) as client:
            request = await personal_model_request(
                client,
                "POST",
                "https://model.example:8443/v1/chat/completions",
                headers={"Authorization": "Bearer personal-key"},
                content=b'{"model":"own-model"}',
                resolver=dns,
            )
            return await client.send(request, follow_redirects=False)

    assert asyncio.run(send()).status_code == 200
    assert dns_calls == [("model.example", 8443)]
    request = observed[0]
    assert str(request.url) == "https://8.8.8.8:8443/v1/chat/completions"
    assert request.headers["host"] == "model.example:8443"
    assert request.extensions["sni_hostname"] == "model.example"
    assert request.headers["authorization"] == "Bearer personal-key"


@pytest.mark.parametrize("port,allowed", [(8001, True), (8002, False), (0, False)])
def test_operator_allowlist_matches_exact_origin_and_port(monkeypatch, port, allowed):
    monkeypatch.setenv(
        "SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS", "http://model.internal:8001"
    )

    async def dns(host, port):
        return ["10.0.0.5"]

    async def build():
        async with httpx.AsyncClient() as client:
            return await personal_model_request(
                client,
                "GET",
                f"http://model.internal:{port}/v1/models",
                headers={},
                resolver=dns,
            )

    if allowed:
        assert asyncio.run(build()).url.host == "10.0.0.5"
    else:
        with pytest.raises(ModelConfigurationError):
            asyncio.run(build())


def test_allowlist_does_not_accept_subdomain_suffix_or_path(monkeypatch):
    monkeypatch.setenv(
        "SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS", "http://model.internal"
    )

    async def dns(host, port):
        return ["10.0.0.5"]

    async def build(url):
        async with httpx.AsyncClient() as client:
            return await personal_model_request(
                client, "GET", url, headers={}, resolver=dns
            )

    with pytest.raises(ModelConfigurationError):
        asyncio.run(build("http://model.internal.attacker/v1/models"))
    monkeypatch.setenv(
        "SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS", "http://model.internal/v1"
    )
    with pytest.raises(ModelConfigurationError):
        asyncio.run(build("http://model.internal/v1/models"))


def test_personal_request_does_not_follow_redirect_to_private_host(monkeypatch):
    monkeypatch.delenv("SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS", raising=False)
    observed = []

    async def dns(host, port):
        return ["8.8.8.8"]

    async def send():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: (
                    observed.append(request)
                    or httpx.Response(
                        302, headers={"Location": "http://127.0.0.1/models"}
                    )
                )
            )
        ) as client:
            request = await personal_model_request(
                client, "GET", "https://model.example/models", headers={}, resolver=dns
            )
            return await client.send(request, follow_redirects=False)

    assert asyncio.run(send()).status_code == 302
    assert len(observed) == 1 and observed[0].url.host == "8.8.8.8"
