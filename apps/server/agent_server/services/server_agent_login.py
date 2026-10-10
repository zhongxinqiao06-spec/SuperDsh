"""Prepare an account's managed runtime without extending login latency."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from loguru import logger

from agent_server.core.server_agent import ServerAgentView
from agent_server.services.server_agent import ServerAgents


class ServerAgentLoginPreparation:
    """Own preparation tasks for the API lifespan, never for a login session.

    The database lease in ServerAgents remains the cross-worker arbiter. Failed
    attempts need an explicit retry; polling auth/me must not keep restarting a
    broken container. Logout does not terminate a user's running Agent.
    """

    def __init__(self, service_factory: Callable[[], ServerAgents]):
        self._service_factory = service_factory
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._attempted: set[str] = set()
        self._errors: dict[str, str] = {}
        self._active = False

    def start(self) -> None:
        self._active = True

    def ensure(self, owner_id: str) -> None:
        if not self._active or owner_id in self._tasks or owner_id in self._attempted:
            return
        task = asyncio.create_task(self._prepare(owner_id))
        self._tasks[owner_id] = task
        task.add_done_callback(lambda done: self._finished(owner_id, done))

    def _finished(self, owner_id: str, task: asyncio.Task[None]) -> None:
        if self._tasks.get(owner_id) is task:
            self._tasks.pop(owner_id, None)

    async def _prepare(self, owner_id: str) -> None:
        try:
            service = self._service_factory()
            # Re-read permissions and account state after authenticating. An
            # old token or a concurrent account change cannot provision a Host.
            if not await service.can_prepare(owner_id):
                return
            current = await service.view(owner_id)
            if current.status in {"running", "starting", "error"} or current.error:
                return
            self._attempted.add(owner_id)
            await service.prepare(owner_id)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - provisioning cannot fail authentication
            self._attempted.add(owner_id)
            self._errors[owner_id] = (
                "server Agent could not be prepared; check supervisor diagnostics and retry"
            )
            logger.warning(
                "automatic server Agent preparation failed for owner {}", owner_id
            )

    async def view(self, owner_id: str) -> ServerAgentView:
        current = await self._service_factory().view(owner_id)
        if current.status == "stopped" and not current.error:
            if owner_id in self._errors:
                return current.model_copy(
                    update={"status": "error", "error": self._errors[owner_id]}
                )
            if owner_id in self._tasks:
                return current.model_copy(update={"status": "starting"})
        return current

    def explicit_retry(self, owner_id: str) -> None:
        self._errors.pop(owner_id, None)

    async def close(self) -> None:
        self._active = False
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
