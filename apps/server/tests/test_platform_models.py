from __future__ import annotations

import asyncio
import base64

import httpx
import pytest
from sqlalchemy import select
from test_auth import bearer, make_client, register

from agent_server.infra.db.platform_models import providers


@pytest.fixture
def platform(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "SUPERDSH_MODEL_ENCRYPTION_KEY", base64.urlsafe_b64encode(b"x" * 32).decode()
    )
    client = make_client(tmp_path)
    admin = register(client, "model-admin").json()
    headers = bearer(admin["accessToken"])
    connector = client.post(
        "/connectors", headers=headers, json={"name": "Model test device"}
    ).json()["connector"]
    return client, admin, headers, connector


def save_provider(client, headers, protocol="openai-completions", **extra):
    return client.post(
        "/api/v2/admin/models/providers",
        headers=headers,
        json={
            "name": "Fixture",
            "protocol": protocol,
            "baseUrl": "http://fixture.test/v1",
            "apiKey": "TEST-PROVIDER-SECRET",
            "models": [{"modelId": "fixture-model", "name": "Fixture model"}],
            **extra,
        },
    )


def test_provider_key_is_encrypted_and_never_in_catalog(platform):
    client, _, headers, _ = platform
    response = save_provider(client, headers)
    assert response.status_code == 200, response.text
    provider = response.json()
    assert provider["apiKeyConfigured"]
    assert "TEST-PROVIDER-SECRET" not in response.text
    default = {"providerId": provider["providerId"], "modelId": "fixture-model"}
    assert (
        client.put(
            "/api/v2/admin/models/default", headers=headers, json={"selection": default}
        ).status_code
        == 200
    )
    catalog = client.get("/api/v2/models/catalog", headers=headers)
    assert catalog.json()["default"] == default
    assert "baseUrl" not in catalog.text and "TEST-PROVIDER-SECRET" not in catalog.text

    async def stored():
        async with client.app.state.store.engine.connect() as connection:
            return (
                await connection.execute(select(providers.c.key_ciphertext))
            ).scalar_one()

    ciphertext = asyncio.run(stored())
    assert "TEST-PROVIDER-SECRET" not in ciphertext


@pytest.mark.parametrize(
    "protocol,operation,auth_header",
    [
        ("openai-completions", "chat/completions", "authorization"),
        ("openai-responses", "responses", "authorization"),
        ("anthropic-messages", "messages", "x-api-key"),
    ],
)
def test_proxy_streams_and_uses_only_server_provider_credentials(
    platform, protocol, operation, auth_header
):
    client, admin, headers, connector = platform
    provider = save_provider(client, headers, protocol).json()
    observed = []

    class FixtureStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"text":"hello"}\n\n'
            yield b"data: [DONE]\n\n"

    def upstream(request):
        observed.append(request)
        return httpx.Response(
            200, stream=FixtureStream(), headers={"content-type": "text/event-stream"}
        )

    client.app.state.platform_model_http_factory = lambda **options: httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), **options
    )
    response = client.post(
        f"/api/v2/models/{provider['providerId']}/{protocol}/{operation}",
        headers={**headers, "X-SuperDsh-Connector-Id": connector["id"]},
        json={"model": "fixture-model", "stream": True, "messages": []},
    )
    assert response.status_code == 200, response.text
    assert response.text.endswith("data: [DONE]\n\n")
    assert observed[0].headers[auth_header].endswith("TEST-PROVIDER-SECRET")
    assert admin["accessToken"] not in str(observed[0].headers)
    assert "X-SuperDsh-Connector-Id" not in observed[0].headers


def test_proxy_rejects_wrong_owner_blocked_device_and_unconfigured_model(platform):
    client, _, headers, connector = platform
    provider = save_provider(client, headers).json()
    url = f"/api/v2/models/{provider['providerId']}/openai-completions/chat/completions"
    proxy_headers = {**headers, "X-SuperDsh-Connector-Id": connector["id"]}
    assert (
        client.post(
            url, headers=proxy_headers, json={"model": "missing-model"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            url,
            headers={**headers, "X-SuperDsh-Connector-Id": "another-device"},
            json={"model": "fixture-model"},
        ).status_code
        == 403
    )
    blocked = client.post(
        f"/api/v2/admin/devices/{connector['id']}/block",
        headers=headers,
        json={"reason": "test"},
    )
    assert blocked.status_code == 200, blocked.text
    assert (
        client.post(
            url, headers=proxy_headers, json={"model": "fixture-model"}
        ).status_code
        == 403
    )


def test_default_validation_and_key_configuration(platform, monkeypatch):
    client, _, headers, _ = platform
    monkeypatch.delenv("SUPERDSH_MODEL_ENCRYPTION_KEY")
    result = save_provider(client, headers)
    assert result.status_code == 422
    monkeypatch.setenv(
        "SUPERDSH_MODEL_ENCRYPTION_KEY", base64.urlsafe_b64encode(b"x" * 32).decode()
    )
    provider = save_provider(client, headers).json()
    assert (
        client.put(
            "/api/v2/admin/models/default",
            headers=headers,
            json={
                "selection": {"providerId": provider["providerId"], "modelId": "absent"}
            },
        ).status_code
        == 422
    )
    duplicate = save_provider(
        client,
        headers,
        models=[{"modelId": "same", "name": "A"}, {"modelId": "same", "name": "B"}],
    )
    assert duplicate.status_code == 422
    assert client.get("/api/v2/models/catalog", headers=headers).status_code == 200


def test_model_stream_revocation_closes_upstream_while_idle(platform):
    client, admin, headers, connector = platform
    provider = save_provider(client, headers).json()
    observed = {"closed": False, "cancelled": False}

    class RevokingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"data: first\n\n"
            await client.app.state.store.revoke_login(user_id=admin["userId"])
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                observed["cancelled"] = True
                raise
            yield b"data: forbidden\n\n"

        async def aclose(self):
            observed["closed"] = True

    client.app.state.platform_model_http_factory = lambda **options: httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200,
                stream=RevokingStream(),
                headers={"content-type": "text/event-stream"},
            )
        ),
        **options,
    )
    response = client.post(
        f"/api/v2/models/{provider['providerId']}/openai-completions/chat/completions",
        headers={**headers, "X-SuperDsh-Connector-Id": connector["id"]},
        json={"model": "fixture-model", "stream": True},
    )
    assert response.text == "data: first\n\n"
    assert observed == {"closed": True, "cancelled": True}


def test_member_cannot_manage_platform_keys_or_use_another_users_device(platform):
    client, _, headers, connector = platform
    provider = save_provider(client, headers).json()
    created = client.post(
        "/admin/users",
        headers=headers,
        json={
            "username": "personal-user",
            "displayName": "Personal",
            "password": "initial-password",
        },
    )
    assert created.status_code == 201
    first = client.post(
        "/auth/login",
        json={"identifier": "personal-user", "password": "initial-password"},
    ).json()
    changed = client.post(
        "/auth/change-password",
        headers=bearer(first["accessToken"]),
        json={"newPassword": "personal-password"},
    )
    assert changed.status_code == 204
    member = client.post(
        "/auth/login",
        json={"identifier": "personal-user", "password": "personal-password"},
    ).json()
    member_headers = bearer(member["accessToken"])
    assert (
        client.get("/api/v2/admin/models/providers", headers=member_headers).status_code
        == 403
    )
    assert (
        client.get("/api/v2/models/catalog", headers=member_headers).status_code == 200
    )
    response = client.post(
        f"/api/v2/models/{provider['providerId']}/openai-completions/chat/completions",
        headers={**member_headers, "X-SuperDsh-Connector-Id": connector["id"]},
        json={"model": "fixture-model"},
    )
    assert response.status_code == 403


def test_revocation_cancels_provider_before_response_headers(platform):
    client, admin, headers, connector = platform
    provider = save_provider(client, headers).json()
    observed = {"cancelled": False}

    async def waiting_provider(_):
        await client.app.state.store.revoke_login(user_id=admin["userId"])
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            observed["cancelled"] = True
            raise
        return httpx.Response(200, content=b"must never finish")

    client.app.state.platform_model_http_factory = lambda **options: httpx.AsyncClient(
        transport=httpx.MockTransport(waiting_provider), **options
    )
    response = client.post(
        f"/api/v2/models/{provider['providerId']}/openai-completions/chat/completions",
        headers={**headers, "X-SuperDsh-Connector-Id": connector["id"]},
        json={"model": "fixture-model", "stream": True},
    )
    assert response.status_code == 403
    assert observed["cancelled"]
