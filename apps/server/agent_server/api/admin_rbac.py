from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agent_server.core.models import UserView
from agent_server.core.permissions import PERMISSIONS
from agent_server.deps import get_store, require_permission
from agent_server.infra.repositories.facade import Store

router = APIRouter(prefix="/admin", tags=["roles"])


class RoleRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    permissions: list[str]


@router.get("/roles")
async def role_catalog(
    user: UserView = Depends(require_permission("roles.manage")),
    db: Store = Depends(get_store),
) -> dict:
    return {
        "roles": await db.role_catalog(),
        "permissions": [
            {"id": key, "label": label} for key, label in PERMISSIONS.items()
        ],
    }


@router.post("/roles", status_code=201)
async def create_role(
    payload: RoleRequest,
    user: UserView = Depends(require_permission("roles.manage")),
    db: Store = Depends(get_store),
) -> dict:
    return await _save(None, payload, user, db)


@router.patch("/roles/{role_id}")
async def edit_role(
    role_id: str,
    payload: RoleRequest,
    user: UserView = Depends(require_permission("roles.manage")),
    db: Store = Depends(get_store),
) -> dict:
    return await _save(role_id, payload, user, db)


async def _save(
    role_id: str | None, payload: RoleRequest, user: UserView, db: Store
) -> dict:
    try:
        role = await db.save_role(
            role_id,
            name=payload.name,
            description=payload.description,
            permissions=payload.permissions,
            actor=user,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="role not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await db.record_audit(
        user.userId, "role.updated" if role_id else "role.created", role["id"]
    )
    return role


@router.delete("/roles/{role_id}", status_code=204)
async def delete_role(
    role_id: str,
    user: UserView = Depends(require_permission("roles.manage")),
    db: Store = Depends(get_store),
) -> None:
    try:
        await db.delete_role(role_id, actor=user)
    except KeyError:
        raise HTTPException(status_code=404, detail="role not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await db.record_audit(user.userId, "role.deleted", role_id)


@router.post("/users/{user_id}/restore", response_model=UserView)
async def restore_user(
    user_id: str,
    user: UserView = Depends(require_permission("users.manage")),
    db: Store = Depends(get_store),
) -> UserView:
    try:
        await db.assert_user_manageable(user_id, user)
        restored = await db.restore_user(user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    await db.record_audit(user.userId, "user.restored", user_id)
    return restored


@router.post("/users/{user_id}/password-reset")
async def request_reset(
    user_id: str,
    user: UserView = Depends(require_permission("users.manage")),
    db: Store = Depends(get_store),
) -> dict:
    try:
        await db.assert_user_manageable(user_id, user)
        await db.request_password_reset(user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    await db.record_audit(user.userId, "user.recovery.requested", user_id)
    return {"status": "recovery_required"}


@router.get("/audit")
async def audit(
    page: int | None = None,
    pageSize: int | None = None,
    search: str = "",
    user: UserView = Depends(require_permission("audit.read")),
    db: Store = Depends(get_store),
) -> dict:
    return await db.management_audit(page=page, page_size=pageSize, search=search)
