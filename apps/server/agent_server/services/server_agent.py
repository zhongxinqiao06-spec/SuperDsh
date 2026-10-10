from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

import httpx
from loguru import logger
from sqlalchemy import insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine

from agent_server.core.models import UserView
from agent_server.core.server_agent import ServerAgentView
from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import connectors, device_runtimes, projects, users
from agent_server.infra.db.server_agent import server_agents
from agent_server.services.platform_models import (
    ModelConfigurationError,
    PlatformModels,
)


class AgentStore(Protocol):
    engine: AsyncEngine

    async def get_user(self, user_id: str) -> UserView: ...
    async def effective_permissions(self, user: UserView) -> list[str]: ...
    async def connector_admitted(self, connector_id: str) -> bool: ...
    async def record_audit(
        self, actor_id: str, action: str, target_id: str, detail: dict | None = None
    ) -> None: ...


class ServerAgentError(ValueError):
    pass


Ready = Callable[[str], Awaitable[bool]]


class ServerAgents:
    """Own account bindings, admission and a cross-worker preparation lease.

    Supervisor owns the fixed container template. Only Connector admission and
    the running DSH runtime can establish readiness, never an HTTP start reply.
    """

    def __init__(
        self, store: AgentStore, online: Ready, http_factory=httpx.AsyncClient
    ):
        self.store = store
        self.online = online
        self.http_factory = http_factory

    async def _binding(self, owner_id: str):
        async with self.store.engine.connect() as conn:
            return (
                (
                    await conn.execute(
                        select(server_agents).where(
                            server_agents.c.owner_user_id == owner_id
                        )
                    )
                )
                .mappings()
                .first()
            )

    async def _admitted(self, owner_id: str, connector_id: str) -> bool:
        try:
            user = await self.store.get_user(owner_id)
        except KeyError:
            return False
        return (
            not user.disabled
            and not user.deletedAt
            and not user.resetRequired
            and {"models.use", "sessions.run"}.issubset(
                await self.store.effective_permissions(user)
            )
            and await self.store.connector_admitted(connector_id)
        )

    async def can_prepare(self, owner_id: str) -> bool:
        try:
            user = await self.store.get_user(owner_id)
        except KeyError:
            return False
        return (
            not user.disabled
            and not user.deletedAt
            and not user.resetRequired
            and {"devices.manage", "models.use", "sessions.run"}.issubset(
                await self.store.effective_permissions(user)
            )
        )

    async def _running(self, binding) -> bool:
        if not await self._admitted(binding["owner_user_id"], binding["connector_id"]):
            return False
        if not await self.online(binding["connector_id"]):
            return False
        async with self.store.engine.connect() as conn:
            row = (
                await conn.execute(
                    select(device_runtimes.c.status, device_runtimes.c.active).where(
                        device_runtimes.c.connector_id == binding["connector_id"],
                        device_runtimes.c.runtime_id == binding["runtime_id"],
                        device_runtimes.c.runtime_type == "dsh",
                    )
                )
            ).first()
        return bool(row and row.status == "running" and row.active)

    async def view(self, owner_id: str) -> ServerAgentView:
        binding = await self._binding(owner_id)
        if binding is None:
            if not await self.can_prepare(owner_id):
                return ServerAgentView(error="server Agent execution permission required")
            try:
                self._supervisor_configuration()
            except ServerAgentError as exc:
                return ServerAgentView(error=str(exc))
            return ServerAgentView()
        if not await self._admitted(owner_id, binding["connector_id"]):
            status, error = (
                "stopped",
                "server Agent connection is unavailable for this account",
            )
        elif await self._running(binding):
            await self._mark_running(binding)
            status, error = "running", None
        elif binding["status"] == "starting" and binding["lease_expires_at"] > int(
            time.time()
        ):
            status, error = "starting", None
        elif binding["status"] == "starting":
            status, error = (
                "error",
                "server Harness did not become ready; check runtime diagnostics and retry",
            )
        elif binding["status"] == "error":
            status, error = "error", binding["error"]
        else:
            status, error = "stopped", None
        if status == "stopped" and error is None:
            if not await self.can_prepare(owner_id):
                error = "server Agent execution permission required"
            else:
                try:
                    self._supervisor_configuration()
                except ServerAgentError as exc:
                    error = str(exc)
        return ServerAgentView(
            status=status,
            error=error,
            connectorId=binding["connector_id"],
            runtimeId=binding["runtime_id"],
            projectId=binding["project_id"],
        )

    async def _mark_running(self, binding) -> None:
        if (
            binding["status"] == "running"
            and not binding["lease_expires_at"]
            and binding["error"] is None
        ):
            return
        # A readiness observation completes its startup lease immediately.
        # Otherwise a crash before the next watchdog sweep still looks like a
        # pending initial startup and can strand an already-ready worker.
        async with self.store.engine.begin() as conn:
            await conn.execute(
                update(server_agents)
                .where(
                    server_agents.c.owner_user_id == binding["owner_user_id"],
                    server_agents.c.lease_id == binding["lease_id"],
                )
                .values(
                    status="running",
                    lease_expires_at=0,
                    error=None,
                    updated_at=utc_now(),
                )
            )

    @staticmethod
    def _supervisor_configuration() -> tuple[str, str, str]:
        url = os.environ.get("SUPERDSH_AGENT_SUPERVISOR_URL", "").rstrip("/")
        secret = os.environ.get("SUPERDSH_AGENT_SUPERVISOR_SECRET", "")
        server_url = os.environ.get(
            "SUPERDSH_AGENT_SERVER_URL", "http://server-next:8000"
        ).rstrip("/")
        if not url or not secret:
            raise ServerAgentError("server Agent supervisor is not configured")
        return url, secret, server_url

    async def _lease(self, owner_id: str) -> tuple[Any, bool]:
        now, seconds = utc_now(), int(time.time())
        async with self.store.engine.begin() as conn:
            # User-row locking serializes first creation as well as subsequent
            # leases in production, even before an owner binding exists.
            if conn.dialect.name == "postgresql":
                lock = int.from_bytes(
                    hashlib.sha256(owner_id.encode()).digest()[:8], "big", signed=True
                )
                await conn.execute(
                    text("SELECT pg_advisory_xact_lock(:lock)"), {"lock": lock}
                )
            else:
                # Acquire SQLite's write reservation before reading the absent
                # binding. This also exercises first-create concurrency in tests.
                await conn.execute(
                    update(users)
                    .where(users.c.id == owner_id)
                    .values(auth_version=users.c.auth_version)
                )
            owner = (
                await conn.execute(
                    select(users.c.id, users.c.disabled, users.c.deleted_at)
                    .where(users.c.id == owner_id)
                    .with_for_update()
                )
            ).first()
            if not owner or owner.disabled or owner.deleted_at:
                raise ServerAgentError("account unavailable")
            binding = (
                (
                    await conn.execute(
                        select(server_agents)
                        .where(server_agents.c.owner_user_id == owner_id)
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if binding and binding["lease_expires_at"] > seconds:
                return binding, False
            if binding is None:
                digest = hashlib.sha256(owner_id.encode()).hexdigest()[:24]
                connector_id, project_id = (
                    f"conn_server_{digest}",
                    f"proj_server_{digest}",
                )
                token = f"cxt_{secrets.token_urlsafe(32)}"
                ciphertext = PlatformModels._seal(
                    token, f"server-agent:{owner_id}:{connector_id}"
                )
                await conn.execute(
                    insert(connectors).values(
                        id=connector_id,
                        user_id=owner_id,
                        name="服务端 Agent",
                        connector_kind="cli",
                        executor_kind="server-agent",
                        device_os="linux",
                        status="offline",
                        token_hash=hashlib.sha256(token.encode()).hexdigest(),
                        token_prefix=token[:12],
                        created_at=now,
                        updated_at=now,
                    )
                )
                existing_names = set(
                    (
                        await conn.execute(
                            select(projects.c.name).where(
                                projects.c.user_id == owner_id
                            )
                        )
                    ).scalars()
                )
                project_name = "服务端工作区"
                suffix = 1
                while project_name in existing_names:
                    project_name = f"服务端工作区 ({suffix})"
                    suffix += 1
                await conn.execute(
                    insert(projects).values(
                        id=project_id,
                        user_id=owner_id,
                        connector_id=connector_id,
                        name=project_name,
                        workspace_path="/workspace",
                        workspace_key="/workspace",
                        manually_created=False,
                        created_at=now,
                        updated_at=now,
                    )
                )
                await conn.execute(
                    insert(server_agents).values(
                        owner_user_id=owner_id,
                        connector_id=connector_id,
                        runtime_id="dsh",
                        project_id=project_id,
                        credential_ciphertext=ciphertext,
                        created_at=now,
                        updated_at=now,
                    )
                )
            lease_id = secrets.token_hex(16)
            await conn.execute(
                update(server_agents)
                .where(server_agents.c.owner_user_id == owner_id)
                .values(
                    lease_id=lease_id,
                    lease_expires_at=seconds + 120,
                    status="starting",
                    error=None,
                    updated_at=now,
                )
            )
            binding = (
                (
                    await conn.execute(
                        select(server_agents).where(
                            server_agents.c.owner_user_id == owner_id
                        )
                    )
                )
                .mappings()
                .one()
            )
        return binding, True

    async def _release_preparation_lease(self, binding) -> None:
        async with self.store.engine.begin() as conn:
            await conn.execute(
                update(server_agents)
                .where(
                    server_agents.c.owner_user_id == binding["owner_user_id"],
                    server_agents.c.lease_id == binding["lease_id"],
                )
                .values(
                    status="stopped",
                    lease_expires_at=0,
                    error=None,
                    updated_at=utc_now(),
                )
            )

    async def prepare(self, owner_id: str) -> ServerAgentView:
        if not await self.can_prepare(owner_id):
            raise ServerAgentError("server Agent execution permission required")
        current = await self.view(owner_id)
        if current.status == "running":
            return current
        url, secret, server_url = self._supervisor_configuration()
        existing = await self._binding(owner_id)
        if existing and not await self._admitted(owner_id, existing["connector_id"]):
            raise ServerAgentError(
                "server Agent connection is blocked or permissions were revoked"
            )
        binding, leased = await self._lease(owner_id)
        try:
            admitted = await self.can_prepare(owner_id) and await self._admitted(
                owner_id, binding["connector_id"]
            )
        except asyncio.CancelledError:
            if leased:
                await self._release_preparation_lease(binding)
            raise
        if not admitted:
            # Admission can change while acquiring the lease. Release only our
            # lease so a denied request cannot stall a later restore/retry.
            if leased:
                await self._release_preparation_lease(binding)
            raise ServerAgentError(
                "server Agent connection is blocked or permissions were revoked"
            )
        if not leased:
            return await self.view(owner_id)
        try:
            token = PlatformModels._open(
                binding["credential_ciphertext"],
                f"server-agent:{owner_id}:{binding['connector_id']}",
            )
            async with self.http_factory(timeout=20, follow_redirects=False) as client:
                response = await client.post(
                    f"{url}/agents",
                    headers={"Authorization": f"Bearer {secret}"},
                    json={
                        "ownerUserId": owner_id,
                        "connectorId": binding["connector_id"],
                        "connectorToken": token,
                        "runtimeId": binding["runtime_id"],
                        "serverUrl": server_url,
                    },
                )
            if response.status_code >= 300 or response.json().get("status") not in {
                "starting",
                "running",
            }:
                raise ServerAgentError(
                    "server Agent could not be prepared; check supervisor diagnostics and retry"
                )
            await self.store.record_audit(
                owner_id, "server-agent.prepare", binding["connector_id"]
            )
        except asyncio.CancelledError:
            # Do not strand a lease when the API process is shutting down.
            await self._release_preparation_lease(binding)
            raise
        except (httpx.HTTPError, ValueError, ModelConfigurationError):
            async with self.store.engine.begin() as conn:
                await conn.execute(
                    update(server_agents)
                    .where(
                        server_agents.c.owner_user_id == owner_id,
                        server_agents.c.lease_id == binding["lease_id"],
                    )
                    .values(
                        status="error",
                        error="server Agent could not be prepared; check supervisor diagnostics and retry",
                        lease_expires_at=0,
                        updated_at=utc_now(),
                    )
                )
        return await self.view(owner_id)

    async def reconcile(self) -> None:
        """Re-establish prepared workers without involving login sessions."""
        self._supervisor_configuration()
        async with self.store.engine.connect() as conn:
            owners = list(
                (await conn.execute(select(server_agents.c.owner_user_id))).scalars()
            )
        concurrency = asyncio.Semaphore(8)

        async def reconcile_owner(owner_id: str) -> None:
            async with concurrency:
                try:
                    await self._reconcile_owner(owner_id)
                except Exception:  # noqa: BLE001 - one failed account must not starve others
                    logger.warning(
                        "server Agent reconciliation failed for owner {}; retrying next sweep",
                        owner_id,
                    )

        await asyncio.gather(*(reconcile_owner(owner_id) for owner_id in owners))

    async def _reconcile_owner(self, owner_id: str) -> None:
        binding = await self._binding(owner_id)
        if not binding:
            return
        if not await self._admitted(owner_id, binding["connector_id"]):
            url, secret, _ = self._supervisor_configuration()
            async with self.http_factory(timeout=20, follow_redirects=False) as client:
                response = await client.delete(
                    f"{url}/agents/{owner_id}",
                    headers={"Authorization": f"Bearer {secret}"},
                )
                response.raise_for_status()
            async with self.store.engine.begin() as conn:
                await conn.execute(
                    update(server_agents)
                    .where(server_agents.c.owner_user_id == owner_id)
                    .values(
                        status="stopped",
                        lease_expires_at=0,
                        error=None,
                        updated_at=utc_now(),
                    )
                )
        elif await self._running(binding):
            await self._mark_running(binding)
        elif binding["status"] == "starting" and binding["lease_expires_at"] <= int(
            time.time()
        ):
            async with self.store.engine.begin() as conn:
                await conn.execute(
                    update(server_agents)
                    .where(
                        server_agents.c.owner_user_id == owner_id,
                        server_agents.c.lease_id == binding["lease_id"],
                    )
                    .values(
                        status="error",
                        lease_expires_at=0,
                        error="server Harness did not become ready; check runtime diagnostics and retry",
                        updated_at=utc_now(),
                    )
                )
        elif binding["status"] != "error":
            # Recover process absence; inference is never replayed here.
            await self.prepare(owner_id)


async def server_agent_watchdog(service: ServerAgents) -> None:
    while True:
        try:
            await service.reconcile()
        except (httpx.HTTPError, ServerAgentError, ModelConfigurationError):
            # Configuration absence is valid for a desktop-only deployment.
            # Per-account failures remain available through GET /server-agent.
            pass
        except Exception:  # noqa: BLE001 - retain the infrastructure watchdog
            # Retain reconciliation after an infrastructure interruption. Do
            # not log requests, payloads or supervisor credentials.
            logger.error("server Agent reconciliation failed; retrying next sweep")
        await asyncio.sleep(15)
