"""Registered product navigation and permission-controlled menu configuration."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from agent_server.core.models import UserView
from agent_server.core.navigation import (
    ICONS,
    MODULES,
    MenuConfiguration,
    default_menu_items,
    visible_menu_items,
)
from agent_server.deps import current_user, get_store, require_permission
from agent_server.infra.repositories.facade import Store
from agent_server.infra.repositories.navigation import MenuVersionConflict

router = APIRouter(tags=["navigation"])
Database = Annotated[Store, Depends(get_store)]
Authenticated = Annotated[UserView, Depends(current_user)]
MenuManager = Annotated[UserView, Depends(require_permission("menus.manage"))]


def menu_reader(user: Authenticated) -> UserView:
    if user.resetRequired:
        raise HTTPException(status_code=403, detail="password change required")
    if not {"menus.read", "menus.manage"}.intersection(user.permissions):
        raise HTTPException(status_code=403, detail="menu read permission required")
    return user


MenuReader = Annotated[UserView, Depends(menu_reader)]


async def catalog(db: Store, configuration: dict | None = None) -> dict:
    return {
        **(
            configuration
            if configuration is not None
            else await db.navigation_configuration()
        ),
        "modules": [module.model_dump() for module in MODULES],
        "icons": list(ICONS),
        "roles": [
            {"id": role["id"], "name": role["name"]} for role in await db.role_catalog()
        ],
    }


@router.get("/navigation")
async def navigation(
    response: Response,
    user: Authenticated,
    db: Database,
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    configuration = await db.navigation_configuration()
    permissions = [] if user.resetRequired else user.permissions
    return {
        "version": configuration["version"],
        "items": visible_menu_items(
            configuration["items"],
            roles=user.roles,
            permissions=permissions,
        ),
    }


@router.get("/admin/menus")
async def menus(
    response: Response,
    user: MenuReader,
    db: Database,
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return await catalog(db)


async def save(
    payload: MenuConfiguration, user: UserView, db: Store, *, reset: bool = False
) -> dict:
    try:
        configuration = await db.save_navigation(
            version=payload.version,
            items=[item.model_dump() for item in payload.items],
            actor=user,
            reset=reset,
        )
    except MenuVersionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await catalog(db, configuration)


@router.put("/admin/menus")
async def update_menus(
    payload: MenuConfiguration,
    response: Response,
    user: MenuManager,
    db: Database,
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return await save(payload, user, db)


class ResetMenus(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=1)


@router.post("/admin/menus/reset")
async def reset_menus(
    payload: ResetMenus,
    response: Response,
    user: MenuManager,
    db: Database,
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return await save(
        MenuConfiguration(version=payload.version, items=default_menu_items()),
        user,
        db,
        reset=True,
    )
