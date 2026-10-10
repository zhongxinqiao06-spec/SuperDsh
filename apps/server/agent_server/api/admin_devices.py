from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from agent_server.core.models import UserView
from agent_server.deps import get_store, require_permission
from agent_server.infra.repositories.facade import Store

router = APIRouter(prefix="/admin/devices", tags=["device-operations"])


@router.get("")
async def devices(
    request: Request,
    user: UserView = Depends(require_permission("devices.inventory.read")),
    db: Store = Depends(get_store),
) -> dict:
    inventory = await db.device_inventory()
    for device in inventory:
        device["status"] = (
            "online"
            if await request.app.state.rpc.is_online(device["id"])
            else "offline"
        )
    return {"devices": inventory}


class BlockRequest(BaseModel):
    reason: str = Field(default="", max_length=500)


@router.post("/{connector_id}/block")
async def block(
    connector_id: str,
    payload: BlockRequest,
    request: Request,
    user: UserView = Depends(require_permission("devices.connection.manage")),
    db: Store = Depends(get_store),
) -> dict:
    async with db.connector_lifecycle(connector_id):
        try:
            await db.set_connector_blocked(
                connector_id, blocked=True, actor_id=user.userId, reason=payload.reason
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="device not found") from None
        await request.app.state.rpc.disconnect(
            connector_id, reason="device connection blocked"
        )
        await request.app.state.terminal_broker.remove_relays_for_connector(
            connector_id
        )
    await db.record_audit(
        user.userId, "device.blocked", connector_id, {"reason": payload.reason}
    )
    return {"status": "blocked"}


@router.post("/{connector_id}/resume")
async def resume(
    connector_id: str,
    user: UserView = Depends(require_permission("devices.connection.manage")),
    db: Store = Depends(get_store),
) -> dict:
    async with db.connector_lifecycle(connector_id):
        try:
            await db.set_connector_blocked(
                connector_id, blocked=False, actor_id=user.userId
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="device not found") from None
    await db.record_audit(user.userId, "device.resumed", connector_id)
    return {"status": "resumed"}
