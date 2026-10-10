"""Automatic preparation uses real auth and temporary SQLite, never user data."""

from __future__ import annotations

import asyncio
import base64
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from sqlalchemy import select, update
from test_auth import bearer, make_client, register
from test_server_agent_admission import revoke_execution

from agent_server.infra.db.schema import users
from agent_server.infra.db.server_agent import server_agents
from agent_server.services.server_agent import ServerAgents


@pytest.fixture
def account(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_SERVER_DB_URL", raising=False)
    monkeypatch.delenv("AGENT_SERVER_REDIS_URL", raising=False)
    monkeypatch.setenv(
        "SUPERDSH_MODEL_ENCRYPTION_KEY", base64.urlsafe_b64encode(b"l" * 32).decode()
    )
    monkeypatch.setenv("SUPERDSH_AGENT_SUPERVISOR_URL", "http://supervisor.test")
    monkeypatch.setenv("SUPERDSH_AGENT_SUPERVISOR_SECRET", "TEST-SECRET")
    client = make_client(tmp_path)
    user = register(client, "login-agent").json()
    return client, user, bearer(user["accessToken"])


def install_supervisor(client, handler):
    client.app.state.server_agent_http_factory = lambda **kwargs: httpx.AsyncClient(
        transport=httpx.MockTransport(handler), **kwargs
    )


def login_request(client, client_type="native"):
    return client.post(
        "/api/v2/auth/login",
        json={
            "identifier": "login-agent@example.test",
            "password": "secret",
            "clientType": client_type,
            "clientName": "Automatic Agent test",
        },
    )


def wait_for_status(client, headers, status):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        agent = client.get("/api/v2/server-agent", headers=headers).json()["agent"]
        if agent["status"] == status:
            return agent
        time.sleep(0.01)
    pytest.fail(f"Agent did not reach {status}: {agent}")


async def await_preparation(client):
    # A bounded join observes completion without altering production scheduling.
    tasks = list(client.app.state.server_agent_login._tasks.values())
    if tasks:
        await asyncio.wait_for(asyncio.gather(*tasks), 5)


@pytest.mark.parametrize("client_type", ["web", "native"])
def test_login_does_not_wait_for_supervisor_and_shutdown_cancels(account, client_type):
    client, _, headers = account
    started, cancelled = threading.Event(), threading.Event()
    observed = []

    async def slow_supervisor(request):
        observed.append(request)
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    install_supervisor(client, slow_supervisor)
    with client:
        response = login_request(client, client_type)
        assert response.status_code == 200, response.text
        assert started.wait(5)
        assert not cancelled.is_set()
        assert wait_for_status(client, headers, "starting")["connectorId"]
        # All concurrent restored sessions share one per-owner task and lease.
        with ThreadPoolExecutor(max_workers=5) as pool:
            responses = list(
                pool.map(
                    lambda _: client.get("/api/v2/auth/me", headers=headers),
                    range(10),
                )
            )
        assert all(item.status_code == 200 for item in responses)
        assert len(observed) == 1
    assert cancelled.is_set()
    assert not client.app.state.server_agent_login._tasks

    async def lease():
        async with client.app.state.store.engine.connect() as conn:
            return (await conn.execute(select(server_agents))).mappings().one()

    binding = asyncio.run(lease())
    assert binding["status"] == "stopped" and binding["lease_expires_at"] == 0


def test_failed_preparation_preserves_login_and_does_not_retry_on_auth_poll(account):
    client, _, headers = account
    observed = []

    def failed_supervisor(request):
        observed.append(request)
        return httpx.Response(503, json={"detail": "PRIVATE-SECRET"})

    install_supervisor(client, failed_supervisor)
    with client:
        response = login_request(client)
        assert response.status_code == 200
        agent = wait_for_status(client, headers, "error")
        for _ in range(4):
            assert client.get("/api/v2/auth/me", headers=headers).status_code == 200
        assert len(observed) == 1
        assert "PRIVATE-SECRET" not in agent["error"]
        # A deliberate retry still reuses the original connector identity.
        retry = client.post("/api/v2/server-agent", headers=headers)
        assert retry.json()["agent"]["connectorId"] == agent["connectorId"]
        assert len(observed) == 2


def test_unexpected_preparation_failure_is_redacted_and_does_not_fail_auth(
    account, monkeypatch
):
    client, _, headers = account

    async def unavailable_lease(_service, _owner_id):
        raise RuntimeError("PRIVATE-PROVISIONING-DETAIL")

    monkeypatch.setattr(ServerAgents, "_lease", unavailable_lease)
    with client:
        assert login_request(client).status_code == 200
        agent = wait_for_status(client, headers, "error")
        assert "PRIVATE" not in agent["error"]
        assert client.get("/api/v2/auth/me", headers=headers).status_code == 200


@pytest.mark.parametrize("restore", ["me", "refresh"])
def test_previously_logged_in_user_prepares_on_restore(account, restore):
    client, _, headers = account
    existing = login_request(client).json()
    observed = []

    def supervisor(request):
        observed.append(request)
        return httpx.Response(200, json={"status": "starting"})

    install_supervisor(client, supervisor)
    with client:
        if restore == "me":
            response = client.get("/api/v2/auth/me", headers=headers)
        else:
            response = client.post(
                "/api/v2/auth/refresh", json={"refreshToken": existing["refreshToken"]}
            )
        assert response.status_code == 200, response.text
        client.portal.call(await_preparation, client)
        assert len(observed) == 1
        assert wait_for_status(client, headers, "starting")["connectorId"]


def test_missing_supervisor_is_explicit_without_creating_device(account, monkeypatch):
    client, _, headers = account
    monkeypatch.delenv("SUPERDSH_AGENT_SUPERVISOR_URL")
    with client:
        assert login_request(client).status_code == 200
        client.portal.call(await_preparation, client)
        agent = client.get("/api/v2/server-agent", headers=headers).json()["agent"]
        assert agent["status"] == "stopped" and not agent["connectorId"]
        assert agent["error"] == "server Agent supervisor is not configured"
        assert client.get("/connectors", headers=headers).json()["connectors"] == []


@pytest.mark.parametrize(
    "denial",
    [
        "models.use",
        "sessions.run",
        "devices.manage",
        "password-reset",
        "disabled",
        "deleted",
    ],
)
def test_unavailable_accounts_do_not_create_agent(account, denial):
    client, user, headers = account
    observed = []
    install_supervisor(client, lambda request: observed.append(request))

    async def deny():
        if denial in {"disabled", "deleted"}:
            values = (
                {"disabled": 1}
                if denial == "disabled"
                else {"deleted_at": "2026-01-01T00:00:00Z"}
            )
            async with client.app.state.store.engine.begin() as conn:
                await conn.execute(
                    update(users).where(users.c.id == user["userId"]).values(**values)
                )
        else:
            await revoke_execution(client.app.state.store, user["userId"], denial)

    asyncio.run(deny())
    with client:
        login_request(client)
        client.get("/api/v2/auth/me", headers=headers)
        client.portal.call(await_preparation, client)
        assert observed == []

        async def bindings():
            async with client.app.state.store.engine.connect() as conn:
                return list((await conn.execute(select(server_agents))).mappings())

        assert client.portal.call(bindings) == []


def test_blocked_agent_is_not_unblocked_by_logging_in(account):
    client, user, headers = account
    observed = []

    def supervisor(request):
        observed.append(request)
        return httpx.Response(200, json={"status": "starting"})

    install_supervisor(client, supervisor)
    agent = client.post("/api/v2/server-agent", headers=headers).json()["agent"]
    asyncio.run(
        client.app.state.store.set_connector_blocked(
            agent["connectorId"], blocked=True, actor_id=user["userId"]
        )
    )
    with client:
        assert login_request(client).status_code == 200
        client.portal.call(await_preparation, client)
        assert len([request for request in observed if request.method == "POST"]) == 1
        result = client.get("/api/v2/server-agent", headers=headers).json()["agent"]
        assert result["status"] == "stopped" and result["error"]
        assert not client.portal.call(
            client.app.state.store.connector_admitted, agent["connectorId"]
        )
