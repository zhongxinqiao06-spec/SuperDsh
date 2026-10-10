from __future__ import annotations

import asyncio
import json
import secrets
from contextlib import suppress
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select

from agent_server.core.auth import verify_connector_access_token
from agent_server.core.models import ConnectorView, UserView
from agent_server.core.platform_models import DefaultWrite, ProviderView, ProviderWrite
from agent_server.core.utc import utc_now
from agent_server.deps import get_store, require_permission
from agent_server.infra.db.schema import connectors
from agent_server.infra.repositories.facade import Store
from agent_server.services.personal_model_http import (
    personal_model_request,
    resolve_addresses,
)
from agent_server.services.platform_models import (
    ModelConfigurationError,
    PlatformModels,
    catalog_for_user,
    resolve_for_user,
)

router = APIRouter(tags=["platform-models"])
Admin = Annotated[UserView, Depends(require_permission("models.manage"))]
ModelUser = Annotated[UserView, Depends(require_permission("models.use"))]
Database = Annotated[Store, Depends(get_store)]
ROUTES = {
    ("openai-completions", "chat/completions"),
    ("openai-responses", "responses"),
    ("anthropic-messages", "messages"),
}


@router.get("/admin/models/providers")
async def list_providers(user: Admin, db: Database):
    return {"providers": await PlatformModels(db).list(), "serverTime": utc_now()}


@router.post("/admin/models/providers", response_model=ProviderView)
async def create_provider(payload: ProviderWrite, user: Admin, db: Database):
    try:
        return await PlatformModels(db).save(payload, user.userId)
    except ModelConfigurationError as exc:
        raise HTTPException(422, str(exc)) from None


@router.patch("/admin/models/providers/{provider_id}", response_model=ProviderView)
async def update_provider(
    provider_id: str, payload: ProviderWrite, user: Admin, db: Database
):
    if provider_id not in {item.providerId for item in await PlatformModels(db).list()}:
        raise HTTPException(404, "provider not found")
    try:
        return await PlatformModels(db).save(payload, user.userId, provider_id)
    except KeyError:
        raise HTTPException(404, "provider not found") from None
    except ModelConfigurationError as exc:
        raise HTTPException(422, str(exc)) from None


@router.delete("/admin/models/providers/{provider_id}")
async def delete_provider(provider_id: str, user: Admin, db: Database):
    try:
        await PlatformModels(db).remove(provider_id, user.userId)
    except KeyError:
        raise HTTPException(404, "provider not found") from None
    return {"deleted": True, "serverTime": utc_now()}


@router.get("/admin/models/default")
async def get_default(user: Admin, db: Database):
    return {"selection": await PlatformModels(db).default(), "serverTime": utc_now()}


@router.put("/admin/models/default")
async def put_default(payload: DefaultWrite, user: Admin, db: Database):
    try:
        await PlatformModels(db).set_default(payload.selection, user.userId)
    except ModelConfigurationError as exc:
        raise HTTPException(422, str(exc)) from None
    return {"selection": payload.selection, "serverTime": utc_now()}


@router.get("/models/catalog")
async def model_catalog(user: ModelUser, db: Database):
    return await catalog_for_user(db, user.userId)


async def internal_model_connector(request: Request, db: Database) -> ConnectorView:
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    connector_id = await db.authenticate_connector_access(token)
    if not connector_id:
        raise HTTPException(401, "invalid connector access token")
    connector = await db.get_connector(connector_id)
    owner = await db.get_user(connector.userId)
    if owner.resetRequired or "models.use" not in await db.effective_permissions(owner):
        raise HTTPException(403, "model authorization revoked")
    return connector


InternalConnector = Annotated[ConnectorView, Depends(internal_model_connector)]


@router.get("/connector/models/catalog")
async def connector_model_catalog(connector: InternalConnector, db: Database):
    return await catalog_for_user(db, connector.userId)


async def _still_authorized(
    db: Store,
    token: str,
    connector_id: str,
    owner_id: str,
    *,
    internal: bool = False,
    credential_fingerprint: str | None = None,
) -> bool:
    if internal:
        if credential_fingerprint is None:
            if await db.authenticate_connector_access(token) != connector_id:
                return False
        else:
            async with db.engine.connect() as connection:
                current = (
                    await connection.execute(
                        select(connectors.c.token_hash).where(
                            connectors.c.id == connector_id,
                            connectors.c.user_id == owner_id,
                            connectors.c.revoked == 0,
                        )
                    )
                ).scalar_one_or_none()
            if not current or not secrets.compare_digest(
                current, credential_fingerprint
            ):
                return False
        try:
            user = await db.get_user(owner_id)
        except KeyError:
            return False
    else:
        user = await db.authenticate_user_token(token)
    if (
        not user
        or user.disabled
        or user.deletedAt
        or user.resetRequired
        or user.userId != owner_id
        or "models.use" not in await db.effective_permissions(user)
    ):
        return False
    try:
        connector = await db.get_connector(connector_id)
    except KeyError:
        return False
    return connector.userId == owner_id and await db.connector_admitted(connector.id)


@router.post("/models/{provider_id}/{protocol}/{operation:path}")
async def model_proxy(
    provider_id: str,
    protocol: str,
    operation: str,
    request: Request,
    user: ModelUser,
    db: Database,
    connector_id: Annotated[str, Header(alias="X-SuperDsh-Connector-Id")],
):
    return await _proxy(
        provider_id,
        protocol,
        operation,
        request,
        db,
        connector_id,
        user.userId,
        internal=False,
    )


@router.post("/connector/models/{provider_id}/{protocol}/{operation:path}")
async def connector_model_proxy(
    provider_id: str,
    protocol: str,
    operation: str,
    request: Request,
    connector: InternalConnector,
    db: Database,
):
    return await _proxy(
        provider_id,
        protocol,
        operation,
        request,
        db,
        connector.id,
        connector.userId,
        internal=True,
    )


async def _proxy(
    provider_id: str,
    protocol: str,
    operation: str,
    request: Request,
    db: Store,
    connector_id: str,
    owner_id: str,
    *,
    internal: bool,
):
    if (protocol, operation) not in ROUTES:
        raise HTTPException(404, "model protocol route not found")
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    if not await _still_authorized(
        db, token, connector_id, owner_id, internal=internal
    ):
        raise HTTPException(
            403, "executing device is unavailable or not owned by this account"
        )
    # A request authenticated before an access token expires remains tied to
    # its original Connector credential. Rotation, blocking and permissions
    # still revoke the stream, without requiring a mobile login to stay alive.
    credential_fingerprint = None
    if internal:
        async with db.engine.connect() as connection:
            credential_fingerprint = (
                await connection.execute(
                    select(connectors.c.token_hash).where(
                        connectors.c.id == connector_id,
                        connectors.c.user_id == owner_id,
                    )
                )
            ).scalar_one()
        if (
            verify_connector_access_token(token, credential_hash=credential_fingerprint)
            != connector_id
        ):
            raise HTTPException(403, "model authorization revoked")
    body = await request.body()
    if len(body) > 8 * 1024 * 1024:
        raise HTTPException(413, "model request is too large")
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict) or not isinstance(payload.get("model"), str):
            raise TypeError
        if payload.get("background"):
            raise ValueError
        base_url, key, is_personal = await resolve_for_user(
            db, owner_id, provider_id, protocol, payload["model"]
        )
    except KeyError:
        raise HTTPException(404, "model provider unavailable") from None
    except (ValueError, TypeError):
        raise HTTPException(422, "model request or configuration is invalid") from None
    headers = {
        "Content-Type": "application/json",
        "Accept": request.headers.get("accept", "application/json"),
    }
    if protocol == "anthropic-messages":
        headers["anthropic-version"] = request.headers.get(
            "anthropic-version", "2023-06-01"
        )
        if request.headers.get("anthropic-beta"):
            headers["anthropic-beta"] = request.headers["anthropic-beta"]
        if key:
            headers["x-api-key"] = key
    elif key:
        headers["Authorization"] = f"Bearer {key}"
    factory = getattr(
        request.app.state, "platform_model_http_factory", httpx.AsyncClient
    )
    client = factory(
        timeout=httpx.Timeout(300, connect=15),
        follow_redirects=False,
        **({"trust_env": False} if is_personal else {}),
    )
    try:
        url = f"{base_url}/{operation}"
        if is_personal:
            outbound = await personal_model_request(
                client,
                "POST",
                url,
                headers=headers,
                content=body,
                resolver=getattr(
                    request.app.state, "personal_model_dns_resolver", resolve_addresses
                ),
            )
        else:
            outbound = client.build_request("POST", url, headers=headers, content=body)
    except ModelConfigurationError as exc:
        await client.aclose()
        raise HTTPException(422, str(exc)) from None
    upstream = None
    connecting = asyncio.create_task(
        client.send(
            outbound,
            stream=True,
        )
    )
    try:
        # Providers may delay response headers. Cancel/revoke during that wait
        # just as during the subsequent stream; do not leave inference running.
        while True:
            done, _ = await asyncio.wait({connecting}, timeout=1)
            if done:
                upstream = connecting.result()
                break
            if await request.is_disconnected():
                raise HTTPException(499, "model request cancelled")
            if not await _still_authorized(
                db,
                token,
                connector_id,
                owner_id,
                internal=internal,
                credential_fingerprint=credential_fingerprint,
            ):
                raise HTTPException(403, "model authorization revoked")
        if upstream.status_code >= 300:
            status = upstream.status_code if 400 <= upstream.status_code < 600 else 502
            await upstream.aclose()
            await client.aclose()
            return JSONResponse(
                {
                    "detail": "model provider rejected the request",
                    "upstreamStatus": upstream.status_code,
                },
                status_code=status,
            )
    except httpx.HTTPError:
        if upstream:
            await upstream.aclose()
        await client.aclose()
        raise HTTPException(502, "model provider connection failed") from None
    except BaseException:
        if upstream:
            await upstream.aclose()
        await client.aclose()
        raise
    finally:
        if not connecting.done():
            connecting.cancel()
            with suppress(asyncio.CancelledError):
                await connecting

    async def stream():
        iterator = upstream.aiter_raw()
        pending = None
        try:
            while True:
                if pending is None:
                    pending = asyncio.create_task(anext(iterator))
                done, _ = await asyncio.wait({pending}, timeout=1)
                if await request.is_disconnected() or not await _still_authorized(
                    db,
                    token,
                    connector_id,
                    owner_id,
                    internal=internal,
                    credential_fingerprint=credential_fingerprint,
                ):
                    break
                if done:
                    try:
                        chunk = pending.result()
                    except StopAsyncIteration:
                        break
                    pending = None
                    yield chunk
        finally:
            if pending and not pending.done():
                pending.cancel()
                with suppress(asyncio.CancelledError):
                    await pending
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        stream(),
        media_type=upstream.headers.get("content-type", "application/json"),
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
