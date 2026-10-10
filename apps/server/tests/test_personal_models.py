from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
from sqlalchemy import select
from test_auth import bearer, make_client, register
from test_platform_models import save_provider

from agent_server.infra.db.platform_models import providers
from agent_server.services.platform_models import (
    ModelConfigurationError,
    PlatformModels,
)


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "SUPERDSH_MODEL_ENCRYPTION_KEY", base64.urlsafe_b64encode(b"p" * 32).decode()
    )
    monkeypatch.setenv("SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS", "http://fixture.test")
    client = make_client(tmp_path)

    async def fixture_dns(host, port):
        assert (host, port) == ("fixture.test", 80)
        return ["127.0.0.1"]

    client.app.state.personal_model_dns_resolver = fixture_dns
    admin = register(client, "personal-admin").json()
    headers = bearer(admin["accessToken"])
    created = client.post(
        "/admin/users",
        headers=headers,
        json={
            "username": "model-owner",
            "displayName": "Owner",
            "password": "initial-password",
        },
    )
    assert created.status_code == 201
    first = client.post(
        "/auth/login",
        json={"identifier": "model-owner", "password": "initial-password"},
    ).json()
    assert (
        client.post(
            "/auth/change-password",
            headers=bearer(first["accessToken"]),
            json={"newPassword": "personal-password"},
        ).status_code
        == 204
    )
    member = client.post(
        "/auth/login",
        json={"identifier": "model-owner", "password": "personal-password"},
    ).json()
    return client, admin, headers, member, bearer(member["accessToken"])


def personal(client, headers, protocol="openai-completions", **extra):
    return client.post(
        "/api/v2/models/personal/providers",
        headers=headers,
        json={
            "name": "Personal fixture",
            "protocol": protocol,
            "baseUrl": "http://fixture.test/v1",
            "apiKey": "PERSONAL-SECRET",
            "models": [{"modelId": "personal-model", "name": "Personal"}],
            **extra,
        },
    )


def connector_access(client, headers):
    response = client.post(
        "/connectors", headers=headers, json={"name": "Own worker"}
    ).json()
    device = response["connector"]["id"]
    auth = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {device}:{response['connectorToken']}"},
    )
    assert auth.status_code == 200, auth.text
    return device, bearer(auth.json()["accessToken"])


def test_personal_credentials_are_scoped_encrypted_and_preserved_when_omitted(accounts):
    client, _, admin_headers, member, owner_headers = accounts
    created = personal(client, owner_headers)
    assert created.status_code == 200, created.text
    provider = created.json()
    provider_id = provider["providerId"]
    assert provider["source"] == "personal" and provider["apiKeyConfigured"]
    assert "PERSONAL-SECRET" not in created.text
    assert (
        client.get("/api/v2/models/personal/providers", headers=admin_headers).json()[
            "providers"
        ]
        == []
    )
    update_data = {
        "name": "Renamed",
        "protocol": "openai-completions",
        "baseUrl": "http://fixture.test/v1",
        "models": [{"modelId": "personal-model", "name": "Personal"}],
    }
    assert (
        client.patch(
            f"/api/v2/models/personal/providers/{provider_id}",
            headers=admin_headers,
            json=update_data,
        ).status_code
        == 404
    )
    assert (
        client.delete(
            f"/api/v2/models/personal/providers/{provider_id}", headers=admin_headers
        ).status_code
        == 404
    )
    assert client.patch(
        f"/api/v2/models/personal/providers/{provider_id}",
        headers=owner_headers,
        json=update_data,
    ).json()["apiKeyConfigured"]

    async def stored():
        async with client.app.state.store.engine.connect() as connection:
            return (
                (
                    await connection.execute(
                        select(providers).where(providers.c.id == provider_id)
                    )
                )
                .mappings()
                .one()
            )

    row = asyncio.run(stored())
    assert row["owner_user_id"] == member["userId"]
    assert "PERSONAL-SECRET" not in row["key_ciphertext"]
    assert (
        PlatformModels._open(
            row["key_ciphertext"], f"personal:{member['userId']}:{provider_id}"
        )
        == "PERSONAL-SECRET"
    )
    with pytest.raises(ModelConfigurationError):
        PlatformModels._open(row["key_ciphertext"], provider_id)


def test_personal_default_does_not_modify_platform_default_or_another_account(accounts):
    client, _, admin_headers, _, owner_headers = accounts
    global_provider = save_provider(client, admin_headers).json()
    global_selection = {
        "providerId": global_provider["providerId"],
        "modelId": "fixture-model",
    }
    assert (
        client.put(
            "/api/v2/admin/models/default",
            headers=admin_headers,
            json={"selection": global_selection},
        ).status_code
        == 200
    )
    provider = personal(client, owner_headers).json()
    selection = {"providerId": provider["providerId"], "modelId": "personal-model"}
    assert (
        client.put(
            "/api/v2/models/personal/default",
            headers=owner_headers,
            json={"selection": selection},
        ).status_code
        == 200
    )
    catalog = client.get("/api/v2/models/catalog", headers=owner_headers).json()
    assert (
        catalog["default"] == selection
        and catalog["platformDefault"] == global_selection
    )
    assert {p["source"] for p in catalog["providers"]} == {"personal", "platform"}
    assert len(catalog["scope"]) == 64
    assert "baseUrl" not in json.dumps(catalog) and "SECRET" not in json.dumps(catalog)
    assert (
        client.get("/api/v2/models/catalog", headers=admin_headers).json()["default"]
        == global_selection
    )
    assert (
        client.put(
            "/api/v2/models/personal/default",
            headers=admin_headers,
            json={"selection": selection},
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/v2/models/personal/default",
            headers=owner_headers,
            json={"selection": global_selection},
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    "protocol,operation,credential_header",
    [
        ("openai-completions", "chat/completions", "authorization"),
        ("openai-responses", "responses", "authorization"),
        ("anthropic-messages", "messages", "x-api-key"),
    ],
)
def test_connector_models_survive_client_logout_and_hide_credentials(
    accounts, protocol, operation, credential_header
):
    client, _, admin_headers, member, owner_headers = accounts
    provider = personal(client, owner_headers, protocol).json()
    connector_id, worker_headers = connector_access(client, owner_headers)
    _, admin_worker_headers = connector_access(client, admin_headers)
    observed = []

    class FixtureStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"text":"hello"}\n\ndata: [DONE]\n\n'

    def upstream(request):
        observed.append(request)
        return httpx.Response(
            200, stream=FixtureStream(), headers={"content-type": "text/event-stream"}
        )

    client.app.state.platform_model_http_factory = lambda **options: httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), **options
    )
    asyncio.run(client.app.state.store.revoke_login(user_id=member["userId"]))
    catalog = client.get("/api/v2/connector/models/catalog", headers=worker_headers)
    assert catalog.status_code == 200
    assert catalog.json()["providers"][0]["providerId"] == provider["providerId"]
    url = f"/api/v2/connector/models/{provider['providerId']}/{protocol}/{operation}"
    response = client.post(
        url, headers=worker_headers, json={"model": "personal-model", "stream": True}
    )
    assert response.status_code == 200, response.text
    assert observed[0].headers[credential_header].endswith("PERSONAL-SECRET")
    assert worker_headers["Authorization"].split()[1] not in str(observed[0].headers)
    assert (
        client.post(
            url, headers=admin_worker_headers, json={"model": "personal-model"}
        ).status_code
        == 404
    )
    assert (
        client.get("/api/v2/models/catalog", headers=owner_headers).status_code == 401
    )
    assert (
        client.post(
            f"/api/v2/admin/devices/{connector_id}/block",
            headers=admin_headers,
            json={"reason": "test"},
        ).status_code
        == 200
    )
    assert (
        client.get(
            "/api/v2/connector/models/catalog", headers=worker_headers
        ).status_code
        == 401
    )


@pytest.mark.parametrize("operation", ["verify", "validate"])
def test_validation_is_non_generating_and_returns_only_safe_result(accounts, operation):
    client, _, _, _, owner_headers = accounts
    provider = personal(client, owner_headers).json()
    observed = []

    def upstream(request):
        observed.append(request)
        return httpx.Response(200, json={"data": [{"id": "personal-model"}]})

    client.app.state.platform_model_http_factory = lambda **options: httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), **options
    )
    response = client.post(
        f"/api/v2/models/personal/providers/{provider['providerId']}/{operation}",
        headers=owner_headers,
    )
    assert response.status_code == 200 and response.json()["ok"] is True
    assert observed[0].method == "GET" and observed[0].url.path == "/v1/models"
    assert "PERSONAL-SECRET" not in response.text


@pytest.mark.parametrize("revocation", ["blocked", "credential-rotated"])
def test_connector_stream_permission_revocation_closes_idle_upstream(
    accounts, revocation
):
    client, _, _, member, owner_headers = accounts
    provider = personal(client, owner_headers).json()
    connector_id, worker_headers = connector_access(client, owner_headers)
    observed = {"closed": False, "cancelled": False}

    class RevokingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"data: first\n\n"
            if revocation == "blocked":
                await client.app.state.store.set_connector_blocked(
                    connector_id, blocked=True, actor_id=member["userId"]
                )
            else:
                await client.app.state.store.rotate_connector_token(
                    connector_id, user_id=member["userId"]
                )
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
            lambda _: httpx.Response(200, stream=RevokingStream())
        ),
        **options,
    )
    response = client.post(
        f"/api/v2/connector/models/{provider['providerId']}/openai-completions/chat/completions",
        headers=worker_headers,
        json={"model": "personal-model", "stream": True},
    )
    assert response.text == "data: first\n\n"
    assert observed == {"closed": True, "cancelled": True}


def test_authenticated_worker_stream_survives_access_token_expiry(
    accounts, monkeypatch
):
    from agent_server.core import auth

    client, _, _, _, owner_headers = accounts
    provider = personal(client, owner_headers).json()
    _, worker_headers = connector_access(client, owner_headers)
    now = auth.time.time()

    class LongStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"data: before-expiry\n\n"
            monkeypatch.setattr(auth.time, "time", lambda: now + 3600)
            yield b"data: after-expiry\n\n"

    client.app.state.platform_model_http_factory = lambda **options: httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, stream=LongStream())
        ),
        **options,
    )
    response = client.post(
        f"/api/v2/connector/models/{provider['providerId']}/openai-completions/chat/completions",
        headers=worker_headers,
        json={"model": "personal-model", "stream": True},
    )
    assert response.text == "data: before-expiry\n\ndata: after-expiry\n\n"
    assert (
        asyncio.run(
            client.app.state.store.authenticate_connector_access(
                worker_headers["Authorization"].split()[1]
            )
        )
        is None
    )
