from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
from sqlalchemy import select, update
from test_auth import bearer, make_client, register
from test_runtime_instances_lifecycle import _v2_discovery

from agent_server.core.device_runtime import RuntimeTypeDescriptor
from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import device_runtimes
from agent_server.infra.db.server_agent import server_agents
from agent_server.services.server_agent import ServerAgentError, ServerAgents


@pytest.fixture
def prepared(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "SUPERDSH_MODEL_ENCRYPTION_KEY", base64.urlsafe_b64encode(b"a" * 32).decode()
    )
    monkeypatch.setenv("SUPERDSH_AGENT_SUPERVISOR_URL", "http://supervisor.test")
    monkeypatch.setenv("SUPERDSH_AGENT_SUPERVISOR_SECRET", "TEST-SUPERVISOR-SECRET")
    monkeypatch.setenv("SUPERDSH_AGENT_SERVER_URL", "http://server-next:8000")
    client = make_client(tmp_path)
    admin = register(client, "agent-admin").json()
    observed = []

    def supervisor(request):
        observed.append(request)
        return httpx.Response(
            200, json={"status": "running", "containerId": "fixture-container"}
        )

    factory = lambda **options: httpx.AsyncClient(
        transport=httpx.MockTransport(supervisor), **options
    )
    client.app.state.server_agent_http_factory = factory
    return client, admin, bearer(admin["accessToken"]), observed, factory


async def mark_running(store, connector_id):
    descriptors = [
        RuntimeTypeDescriptor.model_validate(item)
        for item in _v2_discovery(runtime_type="dsh")["runtimeTypes"]
    ]
    await store.replace_connector_runtime_types(connector_id, descriptors)
    async with store.engine.begin() as connection:
        await connection.execute(
            update(device_runtimes)
            .where(device_runtimes.c.connector_id == connector_id)
            .values(status="running", updated_at=utc_now())
        )


def test_discovery_provisions_one_managed_runtime_without_faking_readiness(prepared):
    client, _, headers, _, _ = prepared
    agent = client.post("/api/v2/server-agent", headers=headers).json()["agent"]
    connector_id = agent["connectorId"]

    async def discover():
        store = client.app.state.store
        descriptors = [
            RuntimeTypeDescriptor.model_validate(item)
            for item in _v2_discovery(runtime_type="dsh")["runtimeTypes"]
        ]
        await store.replace_connector_runtime_types(connector_id, descriptors)
        first = await store.get_device_runtime(connector_id, "dsh")
        await store.replace_connector_runtime_types(connector_id, descriptors)
        rows = await store.list_device_runtimes(connector_id)
        return first, rows

    first, rows = asyncio.run(discover())
    assert len(rows) == 1 and rows[0]["runtimeId"] == "dsh"
    assert first["config"] == {"dshHome": "/data/home"}
    assert first["active"] and first["status"] == "stopped"
    assert (
        client.get("/api/v2/server-agent", headers=headers).json()["agent"]["status"]
        == "starting"
    )


@pytest.mark.parametrize(
    "method,suffix,payload",
    [
        (
            "post",
            "",
            {"runtimeType": "dsh", "name": "Extra", "config": {}, "active": True},
        ),
        ("patch", "/dsh", {"name": "Changed"}),
        ("put", "/dsh/config", {"config": {"dshHome": "/other"}}),
        ("put", "/dsh/active", {"active": False}),
        ("delete", "/dsh/config", None),
    ],
)
def test_managed_runtime_cannot_be_reconfigured_by_clients(
    prepared, method, suffix, payload
):
    client, _, headers, _, _ = prepared
    connector_id = client.post("/api/v2/server-agent", headers=headers).json()["agent"][
        "connectorId"
    ]
    response = client.request(
        method,
        f"/connectors/{connector_id}/runtimes{suffix}",
        headers=headers,
        json=payload,
    )
    assert response.status_code == 409, response.text


def test_prepare_creates_real_owner_scoped_binding_and_waits_for_bridge(prepared):
    client, admin, headers, observed, _ = prepared
    initial = client.get("/api/v2/server-agent", headers=headers)
    assert initial.json()["agent"] == {
        "status": "stopped",
        "connectorId": None,
        "runtimeId": None,
        "projectId": None,
        "error": None,
    }
    first = client.post(
        "/api/v2/server-agent",
        headers=headers,
        json={"ownerUserId": "cannot-impersonate", "workspacePath": "D:/host"},
    )
    assert first.status_code == 202, first.text
    agent = first.json()["agent"]
    assert agent["status"] == "starting" and agent["runtimeId"] == "dsh"
    assert (
        client.post("/api/v2/server-agent", headers=headers).json()["agent"][
            "connectorId"
        ]
        == agent["connectorId"]
    )
    assert len(observed) == 1
    body = json.loads(observed[0].content)
    assert body["ownerUserId"] == admin["userId"]
    assert body["runtimeId"] == "dsh" and body["serverUrl"] == "http://server-next:8000"
    assert body["connectorToken"].startswith("cxt_")
    assert observed[0].headers["Authorization"] == "Bearer TEST-SUPERVISOR-SECRET"
    assert "connectorToken" not in first.text and "SECRET" not in first.text
    connector = client.get(
        f"/connectors/{agent['connectorId']}", headers=headers
    ).json()["connector"]
    assert (
        connector["executorKind"] == "server-agent"
        and connector["connectorKind"] == "cli"
    )
    project = next(
        item
        for item in client.get("/projects", headers=headers).json()["projects"]
        if item["id"] == agent["projectId"]
    )
    assert project["workspacePath"] == "/workspace"
    assert (
        client.delete(
            f"/connectors/{agent['connectorId']}", headers=headers
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/connectors/{agent['connectorId']}/revoke", headers=headers
        ).status_code
        == 409
    )
    assert (
        client.delete(f"/projects/{agent['projectId']}", headers=headers).status_code
        == 409
    )
    assert (
        client.post(
            "/projects",
            headers=headers,
            json={
                "connectorId": agent["connectorId"],
                "name": "Host path",
                "workspacePath": "/host",
            },
        ).status_code
        == 422
    )
    asyncio.run(mark_running(client.app.state.store, agent["connectorId"]))
    assert (
        client.get("/api/v2/server-agent", headers=headers).json()["agent"]["status"]
        == "starting"
    )

    async def online(_):
        return True

    monkey_manager = client.app.state.rpc
    monkey_manager.is_online = online
    assert (
        client.get("/api/v2/server-agent", headers=headers).json()["agent"]["status"]
        == "running"
    )
    assert client.post("/api/v2/server-agent", headers=headers).status_code == 200
    assert len(observed) == 1

    async def read_binding():
        async with client.app.state.store.engine.connect() as connection:
            return (await connection.execute(select(server_agents))).mappings().one()

    binding = asyncio.run(read_binding())
    assert body["connectorToken"] not in binding["credential_ciphertext"]


def test_supervisor_failure_is_visible_and_retry_reuses_binding(prepared):
    client, _, headers, _, factory = prepared
    client.app.state.server_agent_http_factory = lambda **options: httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(503, json={"detail": "SUPER-SECRET-ENV"})
        ),
        **options,
    )
    first = client.post("/api/v2/server-agent", headers=headers)
    assert first.status_code == 202 and first.json()["agent"]["status"] == "error"
    assert "SUPER-SECRET-ENV" not in first.text
    assert (
        client.get("/api/v2/server-agent", headers=headers).json()["agent"]["status"]
        == "error"
    )
    client.app.state.server_agent_http_factory = factory
    retry = client.post("/api/v2/server-agent", headers=headers).json()["agent"]
    assert retry["connectorId"] == first.json()["agent"]["connectorId"]
    assert retry["status"] == "starting"


def test_missing_configuration_does_not_register_a_fake_device(prepared, monkeypatch):
    client, _, headers, _, _ = prepared
    monkeypatch.delenv("SUPERDSH_AGENT_SUPERVISOR_SECRET")
    response = client.post("/api/v2/server-agent", headers=headers)
    assert response.status_code == 503
    assert client.get("/connectors", headers=headers).json()["connectors"] == []


def test_two_accounts_cannot_access_each_others_server_connector_or_history(prepared):
    client, _, headers, _, _ = prepared
    created = client.post(
        "/admin/users",
        headers=headers,
        json={
            "username": "second-agent-owner",
            "displayName": "Second",
            "password": "initial-password",
        },
    )
    assert created.status_code == 201
    first_login = client.post(
        "/auth/login",
        json={"identifier": "second-agent-owner", "password": "initial-password"},
    ).json()
    assert (
        client.post(
            "/auth/change-password",
            headers=bearer(first_login["accessToken"]),
            json={"newPassword": "personal-password"},
        ).status_code
        == 204
    )
    member = client.post(
        "/auth/login",
        json={"identifier": "second-agent-owner", "password": "personal-password"},
    ).json()
    member_headers = bearer(member["accessToken"])
    admin_agent = client.post("/api/v2/server-agent", headers=headers).json()["agent"]
    member_agent = client.post("/api/v2/server-agent", headers=member_headers).json()[
        "agent"
    ]
    assert admin_agent["connectorId"] != member_agent["connectorId"]
    assert admin_agent["projectId"] != member_agent["projectId"]
    assert (
        client.get(
            f"/connectors/{member_agent['connectorId']}", headers=headers
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/connectors/{admin_agent['connectorId']}", headers=member_headers
        ).status_code
        == 404
    )
    assert (
        client.get("/api/v2/server-agent", headers=member_headers).json()["agent"][
            "connectorId"
        ]
        == member_agent["connectorId"]
    )

    async def local_history():
        return await client.app.state.store.create_session(
            connector_id=member_agent["connectorId"],
            project_id=member_agent["projectId"],
            user_id=member["userId"],
            runtime="dsh",
            runtime_id="dsh",
            external_session_id="own-harness-session",
            title="Own history",
            cwd="/workspace",
        )

    session = asyncio.run(local_history())
    assert session.executorKind == "server-agent"
    assert (
        client.get(f"/sessions/{session.id}/meta", headers=member_headers).status_code
        == 200
    )
    assert (
        client.get(f"/sessions/{session.id}/meta", headers=headers).status_code == 404
    )
    assert (
        client.get(f"/sessions/{session.id}/snapshot", headers=headers).status_code
        == 404
    )


def test_concurrent_prepare_uses_one_lease_and_preserves_owner_credentials(prepared):
    client, admin, _, observed, factory = prepared

    async def offline(_):
        return False

    async def simultaneous():
        service = ServerAgents(client.app.state.store, offline, factory)
        return await asyncio.gather(
            *(service.prepare(admin["userId"]) for _ in range(5))
        )

    results = asyncio.run(simultaneous())
    assert len({result.connectorId for result in results}) == 1
    assert len(observed) == 1


def test_reconcile_survives_user_logout_but_stops_blocked_account(prepared):
    client, admin, headers, observed, factory = prepared
    agent = client.post("/api/v2/server-agent", headers=headers).json()["agent"]

    async def offline(_):
        return False

    async def reconcile():
        store = client.app.state.store
        await store.revoke_login(user_id=admin["userId"])
        async with store.engine.begin() as connection:
            await connection.execute(
                update(server_agents).values(status="running", lease_expires_at=0)
            )
        service = ServerAgents(store, offline, factory)
        await service.reconcile()
        assert len([request for request in observed if request.method == "POST"]) == 2
        await store.set_connector_blocked(
            agent["connectorId"], blocked=True, actor_id=admin["userId"]
        )
        await service.reconcile()
        assert observed[-1].method == "DELETE"
        assert (await service.view(admin["userId"])).status == "stopped"

    asyncio.run(reconcile())


def test_bridge_readiness_timeout_is_explicit_and_requires_retry(prepared):
    client, _, headers, observed, _ = prepared
    first = client.post("/api/v2/server-agent", headers=headers).json()["agent"]

    async def expire_readiness():
        async with client.app.state.store.engine.begin() as connection:
            await connection.execute(update(server_agents).values(lease_expires_at=0))

    asyncio.run(expire_readiness())
    timed_out = client.get("/api/v2/server-agent", headers=headers).json()["agent"]
    assert timed_out["status"] == "error"
    assert "did not become ready" in timed_out["error"]
    assert len(observed) == 1
    retry = client.post("/api/v2/server-agent", headers=headers).json()["agent"]
    assert (
        retry["connectorId"] == first["connectorId"] and retry["status"] == "starting"
    )
    assert len(observed) == 2


def test_observed_readiness_completes_lease_before_early_worker_crash(prepared):
    client, admin, headers, observed, factory = prepared
    agent = client.post("/api/v2/server-agent", headers=headers).json()["agent"]

    async def online(_):
        return True

    async def offline(_):
        return False

    async def ready_then_crash():
        store = client.app.state.store
        await mark_running(store, agent["connectorId"])
        service = ServerAgents(store, online, factory)
        assert (await service.view(admin["userId"])).status == "running"
        binding = await service._binding(admin["userId"])
        assert binding["status"] == "running" and binding["lease_expires_at"] == 0
        # The first watchdog after an early crash must prepare immediately,
        # rather than waiting 120s and misclassifying it as failed startup.
        service.online = offline
        await service.reconcile()
        assert len(observed) == 2
        assert observed[-1].method == "POST"
        assert (await service.view(admin["userId"])).status == "starting"

    asyncio.run(ready_then_crash())


def test_blocked_prepare_does_not_lease_and_restore_can_prepare_immediately(prepared):
    client, admin, headers, observed, _ = prepared
    agent = client.post("/api/v2/server-agent", headers=headers).json()["agent"]

    async def block():
        store = client.app.state.store
        await store.set_connector_blocked(
            agent["connectorId"], blocked=True, actor_id=admin["userId"]
        )
        async with store.engine.begin() as connection:
            await connection.execute(
                update(server_agents).values(status="stopped", lease_expires_at=0)
            )

    asyncio.run(block())
    assert client.post("/api/v2/server-agent", headers=headers).status_code == 503
    assert len(observed) == 1

    async def restore():
        store = client.app.state.store
        async with store.engine.connect() as connection:
            binding = (await connection.execute(select(server_agents))).mappings().one()
            assert binding["status"] == "stopped" and binding["lease_expires_at"] == 0
        await store.set_connector_blocked(
            agent["connectorId"], blocked=False, actor_id=admin["userId"]
        )

    asyncio.run(restore())
    retry = client.post("/api/v2/server-agent", headers=headers)
    assert retry.status_code == 202 and retry.json()["agent"]["status"] == "starting"
    assert retry.json()["agent"]["connectorId"] == agent["connectorId"]
    assert len(observed) == 2


def test_admission_revoked_during_prepare_releases_only_its_lease(
    prepared, monkeypatch
):
    client, admin, _, observed, factory = prepared

    async def offline(_):
        return False

    async def revoked(_, __):
        return False

    async def exercise():
        service = ServerAgents(client.app.state.store, offline, factory)
        admitted = service._admitted
        monkeypatch.setattr(service, "_admitted", revoked)
        with pytest.raises(ServerAgentError, match="blocked or permissions"):
            await service.prepare(admin["userId"])
        binding = await service._binding(admin["userId"])
        assert binding["status"] == "stopped" and binding["lease_expires_at"] == 0
        assert observed == []
        # A new admitted preparation must not wait for a stale readiness lease.
        monkeypatch.setattr(service, "_admitted", admitted)
        retry = await service.prepare(admin["userId"])
        assert retry.status == "starting" and len(observed) == 1

    asyncio.run(exercise())
