from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import test_server_agent
from sqlalchemy import select, update
from test_auth import bearer
from test_platform_models import save_provider

from agent_server.infra.db.identity_schema import roles
from agent_server.infra.db.schema import users

prepared = test_server_agent.prepared


async def revoke_execution(store, owner_id, permission):
    async with store.engine.begin() as connection:
        if permission == "password-reset":
            await connection.execute(
                update(users).where(users.c.id == owner_id).values(reset_required=1)
            )
        else:
            current = (
                await connection.execute(
                    select(roles.c.permissions_json).where(roles.c.id == "admin")
                )
            ).scalar_one()
            await connection.execute(
                update(roles)
                .where(roles.c.id == "admin")
                .values(
                    permissions_json=json.dumps(
                        [grant for grant in json.loads(current) if grant != permission]
                    )
                )
            )


def managed_credentials(client, headers, observed):
    agent = client.post("/api/v2/server-agent", headers=headers).json()["agent"]
    worker = json.loads(observed[-1].content)
    credentials = {
        "Authorization": f"Connector {agent['connectorId']}:{worker['connectorToken']}"
    }
    result = client.post("/connector/auth", headers=credentials)
    assert result.status_code == 200, result.text
    return agent["connectorId"], credentials, bearer(result.json()["accessToken"])


@pytest.mark.parametrize("permission", ["models.use", "sessions.run", "password-reset"])
def test_execution_revocation_rejects_worker_handshake_and_access_immediately(
    prepared, permission
):
    client, admin, headers, observed, _ = prepared
    worker_id, credentials, access = managed_credentials(client, headers, observed)
    desktop = client.post(
        "/connectors", headers=headers, json={"name": "Unchanged local desktop"}
    ).json()
    desktop_id = desktop["connector"]["id"]
    desktop_credentials = {
        "Authorization": f"Connector {desktop_id}:{desktop['connectorToken']}"
    }
    asyncio.run(revoke_execution(client.app.state.store, admin["userId"], permission))
    assert not asyncio.run(client.app.state.store.connector_admitted(worker_id))
    assert client.post("/connector/auth", headers=credentials).status_code == 401
    assert (
        client.get("/api/v2/connector/models/catalog", headers=access).status_code
        == 401
    )
    assert (
        client.post("/connector/auth", headers=desktop_credentials).status_code == 200
    )


@pytest.mark.parametrize("permission", ["models.use", "sessions.run"])
def test_execution_revocation_closes_existing_worker_stream_before_watchdog(
    prepared, permission
):
    client, admin, headers, observed, _ = prepared
    provider = save_provider(client, headers).json()
    _, _, access = managed_credentials(client, headers, observed)
    lifecycle = {"closed": False, "cancelled": False}

    class RevokingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"data: before-revocation\n\n"
            await revoke_execution(client.app.state.store, admin["userId"], permission)
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                lifecycle["cancelled"] = True
                raise
            yield b"data: forbidden\n\n"

        async def aclose(self):
            lifecycle["closed"] = True

    client.app.state.platform_model_http_factory = lambda **options: httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, stream=RevokingStream())
        ),
        **options,
    )
    response = client.post(
        f"/api/v2/connector/models/{provider['providerId']}/openai-completions/chat/completions",
        headers=access,
        json={"model": "fixture-model", "stream": True},
    )
    assert response.text == "data: before-revocation\n\n"
    assert lifecycle == {"closed": True, "cancelled": True}
