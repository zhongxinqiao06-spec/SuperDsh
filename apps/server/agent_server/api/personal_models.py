from __future__ import annotations

from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from agent_server.core.models import UserView
from agent_server.core.platform_models import DefaultWrite, ProviderView, ProviderWrite
from agent_server.core.utc import utc_now
from agent_server.deps import get_store, require_permission
from agent_server.infra.repositories.facade import Store
from agent_server.services.personal_model_http import (
    personal_model_request,
    resolve_addresses,
)
from agent_server.services.platform_models import (
    ModelConfigurationError,
    PlatformModels,
)

router = APIRouter(prefix="/models/personal", tags=["personal-models"])
Owner = Annotated[UserView, Depends(require_permission("models.personal.manage"))]
Database = Annotated[Store, Depends(get_store)]


@router.get("/providers")
async def list_providers(user: Owner, db: Database):
    return {
        "providers": await PlatformModels(db, user.userId).list(),
        "serverTime": utc_now(),
    }


@router.post("/providers", response_model=ProviderView)
async def create_provider(payload: ProviderWrite, user: Owner, db: Database):
    try:
        return await PlatformModels(db, user.userId).save(payload, user.userId)
    except ModelConfigurationError as exc:
        raise HTTPException(422, str(exc)) from None


@router.patch("/providers/{provider_id}", response_model=ProviderView)
async def update_provider(
    provider_id: str, payload: ProviderWrite, user: Owner, db: Database
):
    try:
        return await PlatformModels(db, user.userId).save(
            payload, user.userId, provider_id
        )
    except KeyError:
        raise HTTPException(404, "provider not found") from None
    except ModelConfigurationError as exc:
        raise HTTPException(422, str(exc)) from None


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: str, user: Owner, db: Database):
    try:
        await PlatformModels(db, user.userId).remove(provider_id, user.userId)
    except KeyError:
        raise HTTPException(404, "provider not found") from None
    return {"deleted": True, "serverTime": utc_now()}


@router.get("/default")
async def get_default(user: Owner, db: Database):
    return {
        "selection": await PlatformModels(db, user.userId).default(),
        "serverTime": utc_now(),
    }


@router.put("/default")
async def put_default(payload: DefaultWrite, user: Owner, db: Database):
    try:
        await PlatformModels(db, user.userId).set_default(
            payload.selection, user.userId
        )
    except ModelConfigurationError as exc:
        raise HTTPException(422, str(exc)) from None
    return {"selection": payload.selection, "serverTime": utc_now()}


@router.post("/providers/{provider_id}/verify")
@router.post("/providers/{provider_id}/validate", include_in_schema=False)
async def validate_provider(
    provider_id: str, request: Request, user: Owner, db: Database
):
    service = PlatformModels(db, user.userId)
    provider = next(
        (item for item in await service.list() if item.providerId == provider_id), None
    )
    if provider is None:
        raise HTTPException(404, "provider not found")
    try:
        url, key = await service.resolve(
            provider_id, provider.protocol, provider.models[0].modelId
        )
    except KeyError:
        raise HTTPException(422, "model provider is disabled") from None
    except ModelConfigurationError as exc:
        raise HTTPException(422, str(exc)) from None
    headers = {"Accept": "application/json"}
    if provider.protocol == "anthropic-messages":
        headers["anthropic-version"] = "2023-06-01"
        if key:
            headers["x-api-key"] = key
    elif key:
        headers["Authorization"] = f"Bearer {key}"
    factory = getattr(
        request.app.state, "platform_model_http_factory", httpx.AsyncClient
    )
    try:
        async with factory(
            timeout=15, follow_redirects=False, trust_env=False
        ) as client:
            outbound = await personal_model_request(
                client,
                "GET",
                f"{url}/models",
                headers=headers,
                resolver=getattr(
                    request.app.state, "personal_model_dns_resolver", resolve_addresses
                ),
            )
            result = await client.send(outbound, follow_redirects=False)
    except ModelConfigurationError as exc:
        raise HTTPException(422, str(exc)) from None
    except httpx.HTTPError:
        raise HTTPException(502, "model provider connection failed") from None
    if result.status_code >= 300:
        raise HTTPException(422, "model provider rejected credential verification")
    return {"ok": True, "serverTime": utc_now()}
