"""身份、菜单及权限的实库成功/拒绝/并发边界。"""

import asyncio
import base64
import hashlib
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text


async def test_auth_refresh_replay_and_session_revocation(
    platform: tuple[object, AsyncClient],
) -> None:
    _app, client = platform
    await bootstrap(client)
    assert (await client.get("/api/auth/me")).status_code == 200
    assert (
        "Path=/api/auth"
        in (
            await client.post(
                "/api/auth/login",
                json={"identifier": "testadmin", "password": "Synthetic-password-123!"},
            )
        ).headers["set-cookie"]
    )
    old = client.cookies.get("superdsh_refresh")
    response = await client.post("/api/auth/refresh", json={})
    assert response.status_code == 200
    access = response.json()["accessToken"]
    assert (await client.post("/api/auth/refresh", json={"refreshToken": old})).status_code == 401
    assert (
        await client.get("/api/auth/me", headers={"Authorization": "Bearer " + access})
    ).status_code == 401
    login = await client.post(
        "/api/auth/login",
        json={
            "identifier": "testadmin",
            "password": "Synthetic-password-123!",
            "clientType": "native",
        },
    )
    assert isinstance(login.json()["refreshToken"], str)
    client.headers["Authorization"] = "Bearer " + login.json()["accessToken"]
    rows = (await client.get("/api/auth/sessions")).json()["sessions"]
    current = next(row for row in rows if row["current"])
    assert (await client.delete("/api/auth/sessions/" + current["id"])).status_code == 204
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_security_session_search_paging_activity_and_revoke(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """手机会话管理使用真实授权，搜索分页和近期活动不会泄露会话凭据。"""
    app, client = platform
    await bootstrap(client)
    issued = []
    for name in ("Android phone", "Android tablet", "Browser workstation"):
        response = await client.post(
            "/api/auth/login",
            json={
                "identifier": "testadmin",
                "password": "Synthetic-password-123!",
                "clientName": name,
            },
        )
        assert response.status_code == 200, response.text
        issued.append(response.json()["accessToken"])
    first = await client.get("/api/auth/sessions", params={"search": "ANDROID", "pageSize": 1})
    second = await client.get(
        "/api/auth/sessions", params={"search": "android", "pageSize": 1, "page": 2}
    )
    assert first.json()["total"] == 2 and second.json()["total"] == 2
    assert first.json()["sessions"][0]["id"] != second.json()["sessions"][0]["id"]
    assert "refresh" not in first.text.lower() and "password" not in first.text.lower()
    account = await app.state.services.identity.authenticate(issued[0])
    old = datetime.now(UTC) - timedelta(hours=2)
    async with app.state.database.engine.begin() as connection:
        await connection.execute(
            text("UPDATE auth_sessions SET last_seen_at=:at WHERE id=:identifier"),
            {"at": old, "identifier": account.session_id},
        )
    assert (
        await client.get("/api/auth/me", headers={"Authorization": "Bearer " + issued[0]})
    ).status_code == 200
    sessions = (await client.get("/api/auth/sessions", params={"search": "Android phone"})).json()[
        "sessions"
    ]
    assert len(sessions) == 1 and datetime.fromisoformat(sessions[0]["lastSeenAt"]) > old
    assert (await client.delete("/api/auth/sessions/" + account.session_id)).status_code == 204
    assert (
        await client.get("/api/auth/me", headers={"Authorization": "Bearer " + issued[0]})
    ).status_code == 401
    assert (await client.get("/api/auth/sessions", params={"search": "Android phone"})).json()[
        "total"
    ] == 0


async def test_legacy_cookie_menu_cas_and_revocation(
    platform: tuple[object, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client, "/api/v2")
    assert any(cookie.path == "/api/v2/auth" for cookie in client.cookies.jar)
    assert (await client.post("/api/v2/auth/refresh", json={})).status_code == 200
    role = (
        await client.post(
            "/api/admin/roles",
            json={"name": "Auditor", "permissions": ["users.read", "menus.read"]},
        )
    ).json()
    created = await client.post(
        "/api/admin/users",
        json={
            "username": "audituser",
            "displayName": "合成审计员",
            "password": "Synthetic-password-456!",
            "roles": [role["id"]],
        },
    )
    assert created.status_code == 201, created.text
    user = created.json()
    assert user["resetRequired"] is True and user["updatedAt"]
    user = await complete_initial_login(client, "audituser", "Synthetic-password-456!")
    member = {"Authorization": "Bearer " + str(user["accessToken"])}
    assert (await client.get("/api/admin/users", headers=member)).status_code == 200
    assert (
        await client.post(
            "/api/admin/users",
            headers=member,
            json={"username": "baduser", "password": "Synthetic-password-456!"},
        )
    ).status_code == 403
    menu = (await client.get("/api/admin/menus")).json()
    assert len(menu["modules"]) == 21 and menu["roles"]
    body = {"version": menu["version"], "items": menu["items"]}
    results = await asyncio.gather(
        client.put("/api/admin/menus", json=body),
        client.put("/api/admin/menus", json=body),
    )
    assert sorted(response.status_code for response in results) == [200, 409]
    assert (
        await client.patch(
            "/api/admin/users/" + str(user["userId"]),
            json={"disabled": True, "revision": user["revision"]},
        )
    ).status_code == 200
    assert (await client.get("/api/auth/me", headers=member)).status_code == 401
    assert (await client.post("/api/v2/auth/logout", json={})).status_code == 204
    assert all(cookie.path != "/api/v2/auth" for cookie in client.cookies.jar)


async def test_pkce_challenge_and_single_use(
    platform: tuple[object, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client)
    verifier = "x" * 64
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    response = await client.post(
        "/api/oauth/authorize",
        json={
            "client_id": "superdsh-desktop",
            "redirect_uri": "http://127.0.0.1:43123/oauth/callback",
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "fixed-state",
            "scope": "openid",
        },
    )
    assert response.status_code == 200, response.text
    code = parse_qs(urlsplit(response.json()["redirectUrl"]).query)["code"][0]
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": "superdsh-desktop",
        "redirect_uri": "http://127.0.0.1:43123/oauth/callback",
        "code_verifier": verifier,
    }
    wrong = {**form, "code_verifier": "y" * 64}
    assert (await client.post("/api/oauth/token", data=wrong)).status_code == 400
    assert (await client.post("/api/oauth/token", data=form)).status_code == 200
    assert (await client.post("/api/oauth/token", data=form)).status_code == 400
