"""Login session and recovery endpoints shared by browser and native clients."""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from agent_server.core.auth import user_access_claims
from agent_server.core.models import AuthResponse, UserView
from agent_server.core.utc import utc_now
from agent_server.deps import current_user, get_store
from agent_server.infra.repositories.facade import Store

router = APIRouter(prefix="/auth", tags=["identity"])
COOKIE_NAME = "superdsh_refresh"
COOKIE_PATH = "/api/v2/auth"


def set_refresh_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=30 * 86400,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        path=COOKIE_PATH,
    )
    response.headers["Cache-Control"] = "no-store"


def check_cookie_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        # SameSite=Strict cookies cannot be sent on cross-site form navigations.
        return
    own = f"{request.url.scheme}://{request.url.netloc}"
    allowed = set(
        filter(None, os.environ.get("AGENT_SERVER_CORS_ORIGINS", "").split(","))
    )
    if origin != own and origin not in allowed:
        raise HTTPException(status_code=403, detail="untrusted cookie request origin")


def auth_payload(login: dict, *, native: bool) -> AuthResponse:
    user = login["user"]
    return AuthResponse(
        userId=user.userId,
        username=user.username,
        email=user.email,
        emailVerified=user.emailVerified,
        displayName=user.displayName,
        role=user.role,
        roles=user.roles,
        permissions=user.permissions,
        authzVersion=user.authzVersion,
        resetRequired=user.resetRequired,
        accessToken=login["accessToken"],
        refreshToken=login["refreshToken"] if native else None,
        serverTime=utc_now(),
    )


def prepare_account_agent(request: Request | None, user_id: str) -> None:
    if request is not None:
        request.app.state.server_agent_login.ensure(user_id)


async def issue_auth(
    db: Store,
    user: UserView,
    *,
    request: Request | None = None,
    response: Response | None = None,
    native: bool = False,
    client_name: str = "Browser",
) -> AuthResponse:
    login = await db.issue_login(user.userId, client_name=client_name)
    if response is not None:
        response.headers["Cache-Control"] = "no-store"
    if not native and request is not None and response is not None:
        set_refresh_cookie(response, request, login["refreshToken"])
    prepare_account_agent(request, login["user"].userId)
    return auth_payload(login, native=native)


class RefreshRequest(BaseModel):
    refreshToken: str | None = None
    clientName: str | None = Field(default=None, max_length=80)


@router.post("/refresh", response_model=AuthResponse)
async def refresh(
    payload: RefreshRequest,
    request: Request,
    response: Response,
    db: Store = Depends(get_store),
) -> AuthResponse:
    native = bool(payload.refreshToken)
    if not native:
        check_cookie_origin(request)
    token = payload.refreshToken or request.cookies.get(COOKIE_NAME)
    login = await db.refresh_login(token) if token else None
    if not login:
        response.delete_cookie(COOKIE_NAME, path=COOKIE_PATH)
        raise HTTPException(status_code=401, detail="login session expired or revoked",
                            headers={"Set-Cookie": response.headers["set-cookie"], "Cache-Control": "no-store"})
    if not native:
        set_refresh_cookie(response, request, login["refreshToken"])
    response.headers["Cache-Control"] = "no-store"
    prepare_account_agent(request, login["user"].userId)
    return auth_payload(login, native=native)


def current_sid(request: Request) -> str | None:
    authorization = request.headers.get("authorization", "")
    claims = user_access_claims(authorization.removeprefix("Bearer "))
    return claims.get("sid") if claims else None


@router.post("/logout", status_code=204)
async def logout(
    payload: RefreshRequest,
    request: Request,
    response: Response,
    db: Store = Depends(get_store),
) -> None:
    token = payload.refreshToken or request.cookies.get(COOKIE_NAME)
    if not payload.refreshToken:
        check_cookie_origin(request)
    if token:
        await db.revoke_login(refresh=token)
    authorization = request.headers.get("authorization", "")
    user = await db.authenticate_user_token(authorization.removeprefix("Bearer "))
    if user and current_sid(request):
        await db.revoke_login(user_id=user.userId, session_id=current_sid(request))
    response.delete_cookie(COOKIE_NAME, path=COOKIE_PATH)


@router.post("/logout-all", status_code=204)
async def logout_all(
    response: Response,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> None:
    await db.revoke_login(user_id=user.userId)
    response.delete_cookie(COOKIE_NAME, path=COOKIE_PATH)


@router.get("/sessions")
async def sessions(
    request: Request,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> dict:
    return {"sessions": await db.login_sessions(user.userId, current_sid(request))}


@router.delete("/sessions/{session_id}", status_code=204)
async def revoke_session(
    session_id: str,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> None:
    await db.revoke_login(user_id=user.userId, session_id=session_id)


@router.post("/recovery-codes")
async def recovery_codes(
    response: Response,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return {"codes": await db.generate_recovery_codes(user.userId)}


class RecoveryRequest(BaseModel):
    identifier: str = Field(max_length=320)
    recoveryCode: str = Field(min_length=16, max_length=128)
    newPassword: str = Field(min_length=8, max_length=1024)


@router.post("/recovery/reset", status_code=204)
async def recover(payload: RecoveryRequest, db: Store = Depends(get_store)) -> None:
    row = await db._email_login_row(payload.identifier)
    if not row or not await db.reset_with_recovery(
        row["id"], payload.recoveryCode, payload.newPassword
    ):
        raise HTTPException(status_code=401, detail="invalid recovery credentials")


class EmailRecoveryRequest(BaseModel):
    email: str = Field(max_length=320)
    code: str = Field(min_length=6, max_length=6)
    newPassword: str = Field(min_length=8, max_length=1024)


@router.post("/recovery/reset-email", status_code=204)
async def recover_email(
    payload: EmailRecoveryRequest, db: Store = Depends(get_store)
) -> None:
    try:
        valid = await db.reset_with_email_code(
            payload.email, payload.code, payload.newPassword
        )
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(status_code=401, detail="invalid recovery credentials")
