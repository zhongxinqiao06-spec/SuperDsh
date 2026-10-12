from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent_server.core.auth import hash_password_verifier
from agent_server.core.models import (
    AdminUserCreateRequest,
    AdminUserListResponse,
    AdminUserUpdateRequest,
    InstanceSettingsUpdateRequest,
    InstanceSettingsView,
    UserView,
)
from agent_server.core.utc import utc_now
from agent_server.deps import get_store, require_permission
from agent_server.infra.repositories.facade import Store
from agent_server.services.email_delivery import (
    get_email_settings,
    public_email_settings,
    update_email_settings,
)

router = APIRouter(prefix="/admin", tags=["admin"])


# --- instance settings -------------------------------------------------------


@router.get("/settings", response_model=InstanceSettingsView, dependencies=[Depends(require_permission("settings.manage"))])
async def get_settings(db: Store = Depends(get_store)) -> InstanceSettingsView:
    return InstanceSettingsView(
        registrationOpen=await db.is_registration_open(),
        oauthRegistrationOpen=await db.is_oauth_registration_open(),
        oauth=await db.get_oauth_provider_public_config(),
        email=public_email_settings(await get_email_settings(db)),
    )


@router.patch("/settings", response_model=InstanceSettingsView, dependencies=[Depends(require_permission("settings.manage"))])
async def update_settings(
    payload: InstanceSettingsUpdateRequest,
    db: Store = Depends(get_store),
) -> InstanceSettingsView:
    if payload.email is not None:
        try:
            await update_email_settings(db, payload.email)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    if payload.registrationOpen is not None:
        await db.set_registration_open(payload.registrationOpen)
    if payload.oauthRegistrationOpen is not None:
        await db.set_oauth_registration_open(payload.oauthRegistrationOpen)
    if payload.oauth is not None:
        await db.set_oauth_provider_config(payload.oauth.model_dump(exclude_none=True))
    return InstanceSettingsView(
        registrationOpen=await db.is_registration_open(),
        oauthRegistrationOpen=await db.is_oauth_registration_open(),
        oauth=await db.get_oauth_provider_public_config(),
        email=public_email_settings(await get_email_settings(db)),
    )


# --- user management ---------------------------------------------------------


@router.get("/users", response_model=AdminUserListResponse, dependencies=[Depends(require_permission("users.read"))])
async def list_users(page: int = 1, pageSize: int = 50, search: str = "", db: Store = Depends(get_store)) -> AdminUserListResponse:
    result = await db.management_users(page=page, page_size=pageSize, search=search)
    return AdminUserListResponse(**result, serverTime=utc_now())


@router.post("/users", response_model=UserView, status_code=201)
async def create_user(
    payload: AdminUserCreateRequest,
    db: Store = Depends(get_store),
    admin: UserView = Depends(require_permission("users.manage")),
) -> UserView:
    try:
        requested_roles = payload.roles or [payload.role]
        catalog = {role["id"]: role for role in await db.role_catalog()}
        if any(role not in catalog for role in requested_roles):
            raise ValueError("role not found")
        requested_permissions = {p for role in requested_roles for p in catalog[role]["permissions"]}
        if not requested_permissions.issubset(admin.permissions):
            raise ValueError("cannot grant permissions you do not hold")
        if requested_roles != ["member"] and "roles.manage" not in admin.permissions:
            raise HTTPException(status_code=403, detail="role management permission required")
        user = await db.create_email_user(
            email=payload.email,
            username=payload.username,
            display_name=payload.displayName,
            password=payload.password,
            password_hash=_password_hash_from_create(payload),
            role="member",
            verification_code=payload.code,
            require_verification=False,
            trust_email=False,
        )
        user = await db.set_user_roles(user.userId, requested_roles, actor=admin)
        await db.request_password_reset(user.userId)
        user = await db.get_user(user.userId)
        await db.record_audit(admin.userId, "user.created", user.userId)
        return user
    except ValueError as exc:
        detail = str(exc)
        if detail in {"user already exists", "email already exists", "email is already in use", "username or email is already in use"}:
            raise HTTPException(status_code=409, detail=detail) from exc
        raise HTTPException(status_code=422, detail=detail) from exc


@router.patch("/users/{user_id}", response_model=UserView)
async def update_user(
    user_id: str,
    payload: AdminUserUpdateRequest,
    db: Store = Depends(get_store),
    admin: UserView = Depends(require_permission("users.manage")),
) -> UserView:
    target = (user_id or "").strip().lower()
    if not target:
        raise HTTPException(status_code=404, detail="user not found")
    if payload.password is not None or payload.passwordVerifier is not None or payload.passwordSalt is not None:
        raise HTTPException(status_code=409, detail="administrators cannot set another account's password; request recovery instead")
    selected_roles = payload.roles if payload.roles is not None else ([payload.role] if payload.role is not None else None)
    if selected_roles is not None and "roles.manage" not in admin.permissions:
        raise HTTPException(status_code=403, detail="role management permission required")

    # Self-protection guards on role/disabled changes.
    if target == admin.userId:
        if payload.role is not None and payload.role != admin.role:
            raise HTTPException(status_code=409, detail="cannot change your own role")
        if payload.disabled is True:
            raise HTTPException(status_code=409, detail="cannot disable yourself")

    updated: UserView | None = None
    try:
        await db.assert_user_manageable(target, admin)
        updated = await db.update_user_admin(target, actor=admin, display_name=payload.displayName,
                                             role_ids=selected_roles, disabled=payload.disabled)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    await db.record_audit(admin.userId, "user.updated", target)
    return updated or await _safe_get_user(db, target)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: str,
    db: Store = Depends(get_store),
    admin: UserView = Depends(require_permission("users.manage")),
) -> None:
    target = (user_id or "").strip().lower()
    if target == admin.userId:
        raise HTTPException(status_code=409, detail="cannot delete yourself")
    try:
        await db.assert_user_manageable(target, admin)
        await db.soft_delete_user(target, actor_id=admin.userId)
        await db.record_audit(admin.userId, "user.deleted", target)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


async def _safe_get_user(db: Store, user_id: str) -> UserView:
    try:
        return await db.get_user(user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found") from None


def _password_hash_from_create(payload: AdminUserCreateRequest) -> str | None:
    if payload.passwordVerifier is None:
        return None
    if not payload.passwordSalt:
        raise HTTPException(status_code=422, detail="password salt is required")
    return hash_password_verifier(payload.passwordVerifier, salt=payload.passwordSalt)


def _password_hash_from_update(payload: AdminUserUpdateRequest) -> str | None:
    if payload.passwordVerifier is None:
        return None
    if not payload.passwordSalt:
        raise HTTPException(status_code=422, detail="password salt is required")
    return hash_password_verifier(payload.passwordVerifier, salt=payload.passwordSalt)
