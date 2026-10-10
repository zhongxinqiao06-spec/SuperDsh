"""One gate for existing HTTP, native streams and derived access tickets.

Permissions do not substitute for the existing resource owner checks in services.
The stream gate checks every frame and polls while idle so revocation also works
between server instances without relying on a local in-memory connection list.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from urllib.parse import parse_qs

from anyio import CancelScope

from agent_server.core.auth import (
    create_user_access_token,
    user_access_claims,
    verify_signed_token,
)
from agent_server.services.authorization_context import authorization_reference


def business_permission(path: str, method: str) -> str | None:
    path = path.removeprefix("/api/v2")
    read = method in {"GET", "HEAD"}
    if path.startswith(("/connectors/", "/sessions/")):
        if "/terminal" in path or "/shell" in path:
            return "terminal.use"
        if (
            "/fs/" in path
            or "/attachments" in path
            or path.startswith("/sessions/local/")
        ):
            writing = any(
                part in path
                for part in ("write", "save", "upload", "mkdir", "move", "delete")
            )
            if method == "DELETE" or ("attachments" in path and method == "POST"):
                writing = True
            return "files.write" if writing else "files.read"
        if "/runtimes" in path and not read:
            return "devices.manage"
    if path.startswith("/connectors"):
        return "devices.read" if read else "devices.manage"
    if path.startswith("/sessions"):
        return "sessions.read" if read else "sessions.run"
    if path.startswith("/projects"):
        return "projects.read" if read else "projects.manage"
    if path.startswith("/pairing"):
        return None if path in {"/pairing/start", "/pairing/poll"} else "devices.manage"
    if path.startswith("/agents"):
        return "models.use" if read else "models.personal.manage"
    if path.startswith("/admin/service"):
        return "settings.manage"
    if path.startswith("/admin/dashboard"):
        return "settings.manage"
    if path.startswith("/admin/announcement"):
        return "settings.manage"
    return None


async def reference_user(db, reference: dict):
    user_id = reference.get("auth_user_id")
    sid = reference.get("auth_session_id")
    version = reference.get("auth_version")
    if not user_id:
        return None
    if not sid and not getattr(db, "allow_legacy_test_tokens", False):
        return None
    token = create_user_access_token(user_id, session_id=sid, auth_version=version)
    return await db.authenticate_user_token(token)


def reference_from_token(token: str) -> dict:
    claims = user_access_claims(token)
    if not claims:
        return {}
    return {
        "auth_user_id": claims["sub"],
        "auth_session_id": claims.get("sid"),
        "auth_version": claims.get("ver"),
    }


class PlatformAuthorizationMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        db = scope["app"].state.store
        path = scope["path"]
        headers = {
            key.decode().lower(): value.decode()
            for key, value in scope.get("headers", [])
        }
        query = parse_qs(scope.get("query_string", b"").decode())
        bearer = headers.get("authorization", "").removeprefix("Bearer ")
        token = bearer
        if not token:
            token = query.get("token", [""])[0]
        state = scope.setdefault("state", {})
        if scope["type"] == "websocket":
            token = (
                bearer
                if path == "/api/v2/connector/ws"
                else query.get("token", [bearer])[0]
            )
            return await self._websocket(scope, receive, send, db, token)
        permission = business_permission(path, scope["method"])
        if not permission:
            return await self.app(scope, receive, send)
        user = await db.authenticate_user_token(token) if token else None
        reference = reference_from_token(token)
        # Always validate the credential the route actually consumes. A valid
        # bearer must never resurrect an expired/revoked derived credential.
        preview = query.get("previewAccessToken", [None])[0]
        preview_body = path.startswith("/api/v2/connectors/fs/preview")
        derived_required = preview_body or preview is not None
        if preview_body:
            chunks = []
            while True:
                frame = await receive()
                chunks.append(frame)
                if frame["type"] != "http.request" or not frame.get("more_body", False):
                    break
            try:
                payload = json.loads(b"".join(item.get("body", b"") for item in chunks))
            except (ValueError, TypeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            preview = payload.get("previewAccessToken") or payload.get("previewToken")
            iterator = iter(chunks)
            original_receive = receive

            async def replay():
                try:
                    return next(iterator)
                except StopIteration:
                    return await original_receive()

            receive = replay
        local_file = path.startswith("/api/v2/sessions/local/")
        derived = None
        if derived_required:
            kind = (
                "fs_preview_open"
                if path.endswith("/fs/preview-session")
                else "fs_preview_access"
            )
            derived = (
                verify_signed_token(kind, preview) if isinstance(preview, str) else None
            )
        elif local_file:
            derived_required = True
            derived = verify_signed_token("local_file", query.get("token", [""])[0])
        if derived_required:
            bearer_user = await db.authenticate_user_token(bearer) if bearer else None
            user = None
            if derived:
                reference = {
                    key: derived.get(key)
                    for key in ("auth_user_id", "auth_session_id", "auth_version")
                }
                user = await reference_user(db, reference)
                if bearer and (
                    not bearer_user or not user or bearer_user.userId != user.userId
                ):
                    user = None
                if user:
                    try:
                        if local_file:
                            session = await db.get_session(
                                derived.get("sessionId", ""), user_id=user.userId
                            )
                            connector_id = session.connectorId
                        else:
                            connector_id = derived.get("connector_id", "")
                            connector = await db.get_connector(connector_id)
                            if (
                                connector.userId != user.userId
                                or derived.get("user_id") != user.userId
                            ):
                                user = None
                        if not await db.connector_admitted(connector_id):
                            user = None
                    except KeyError:
                        user = None
        if not user:
            return await self._http_error(send, 401, "authentication required")
        if user.resetRequired:
            return await self._http_error(send, 403, "password change required")
        if permission not in user.permissions:
            return await self._http_error(
                send, 403, "permission required: " + permission
            )
        state["principal"] = user
        handle = authorization_reference.set(reference)
        try:
            await self.app(scope, receive, send)
        finally:
            authorization_reference.reset(handle)

    @staticmethod
    async def _http_error(send, status: int, detail: str):
        body = json.dumps({"detail": detail}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def _websocket(self, scope, receive, send, db, token):
        path = scope["path"]
        connector_stream = path.startswith("/api/v2/connector/")
        guarded = connector_stream or path.startswith(
            ("/api/v2/connectors/", "/api/v2/sessions/", "/api/v2/dashboard/")
        )
        if not guarded:
            return await self.app(scope, receive, send)
        accepted = False
        closed = False
        app_task = None
        watcher = None

        async def authorized():
            params = scope.get("path_params", {})
            if connector_stream:
                if "terminal_id" in params:
                    terminal = await scope["app"].state.terminal_broker.get(
                        params["terminal_id"]
                    )
                    return bool(
                        terminal
                        and terminal.relay_token == token
                        and await db.connector_admitted(terminal.connector_id)
                    )
                return bool(await db.authenticate_connector_access(token))
            state = scope.get("state", {})
            effective_token = state.get("authorization_token", token)
            user = (
                await db.authenticate_user_token(effective_token)
                if effective_token
                else None
            )
            if not user or user.resetRequired:
                return False
            if state.get("authorization_user_id", user.userId) != user.userId:
                return False
            permission = (
                "terminal.use"
                if "/terminal" in path
                else "devices.read"
                if "/dashboard/" in path
                else "sessions.read"
            )
            if permission not in user.permissions:
                return False
            connector_id = params.get("connector_id")
            session_id = params.get("session_id")
            try:
                if session_id:
                    session = await db.get_session(session_id, user_id=user.userId)
                    connector_id = session.connectorId
                if connector_id:
                    connector = await db.get_connector(connector_id)
                    return (
                        connector.userId == user.userId
                        and await db.connector_admitted(connector_id)
                    )
            except KeyError:
                return False
            return True

        async def close():
            nonlocal closed
            if not closed:
                closed = True
                await send(
                    {
                        "type": "websocket.close",
                        "code": 4403,
                        "reason": "authorization changed",
                    }
                )

        async def monitor():
            while not closed:
                await asyncio.sleep(1)
                try:
                    valid = await authorized()
                except Exception:  # noqa: BLE001 - every store failure must close the stream
                    # Loss of the shared authorization store must not leave an
                    # idle stream authorized indefinitely.
                    valid = False
                if not valid:
                    await close()
                    if app_task:
                        app_task.cancel()
                    return

        async def guarded_send(frame):
            nonlocal accepted, closed, watcher
            if frame["type"] in {"websocket.accept", "websocket.send"} and (
                closed or not await authorized()
            ):
                await close()
                raise asyncio.CancelledError
            if frame["type"] == "websocket.accept":
                accepted = True
                watcher = asyncio.create_task(monitor())
            if frame["type"] == "websocket.close":
                if closed:
                    return
                closed = True
            await send(frame)

        async def guarded_receive():
            frame = await receive()
            if (
                accepted
                and frame["type"] == "websocket.receive"
                and not await authorized()
            ):
                await close()
                return {"type": "websocket.disconnect", "code": 4403}
            return frame

        async def run_application():
            # The parent owns cancellation. Shield route cleanup from repeated
            # ASGI task-group cancellation while it releases DB/relay leases.
            with CancelScope(shield=True):
                await self.app(scope, guarded_receive, guarded_send)

        app_task = asyncio.create_task(run_application())
        try:
            await asyncio.shield(app_task)
        except asyncio.CancelledError:
            with CancelScope(shield=True):
                if not app_task.done():
                    app_task.cancel()
                with suppress(asyncio.CancelledError):
                    await app_task
            if not closed:
                raise
        finally:
            with CancelScope(shield=True):
                if watcher:
                    watcher.cancel()
                    with suppress(asyncio.CancelledError):
                        await watcher
