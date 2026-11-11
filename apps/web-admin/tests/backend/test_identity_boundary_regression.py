"""双入口实库覆盖已观测身份与管理边界，邮件使用合成接收器且不访问真实账户。"""

from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.identity.entity.bo.validation import collision_username


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_avatar_username_management_and_pagination_actual_requests(
    platform: tuple[FastAPI, AsyncClient], prefix: str
) -> None:
    """实际HTTP验证自动用户名、冲突摘要、413、密码保护409和四类分页默认/数字语法。"""
    _, client = platform
    created = await client.post(
        prefix + "/auth/register",
        json={
            "email": "synthetic-admin@example.invalid",
            "displayName": "合成管理员",
            "password": "Synthetic-password-123!",
            "setupToken": "synthetic-setup-token",
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["username"] == "synthetic-admin"
    client.headers["Authorization"] = "Bearer " + created.json()["accessToken"]
    avatar = "data:image/png;base64,aGVsbG8="
    saved = await client.put(prefix + "/auth/me/avatar", json={"avatar": " " + avatar + "\n"})
    assert saved.status_code == 200 and saved.json()["avatar"] == avatar
    oversized = await client.put(
        prefix + "/auth/me/avatar", json={"avatar": "data:image/png;base64," + "A" * (256 * 1024)}
    )
    assert oversized.status_code == 413
    assert oversized.json()["detail"] == "avatar exceeds 256KB limit"
    for index, email in enumerate(("synthetic-member@one.invalid", "synthetic-member@two.invalid")):
        member = await client.post(
            prefix + "/admin/users",
            json={"email": email, "displayName": "合成成员", "password": "Synthetic-member-123!"},
        )
        assert member.status_code == 201, member.text
        expected = (
            "synthetic-member" if index == 0 else collision_username("synthetic-member", email)
        )
        assert member.json()["username"] == expected
        rejected = await client.patch(
            prefix + "/admin/users/" + member.json()["userId"], json={"password": None}
        )
        assert rejected.status_code == 409
        assert "cannot set another account's password" in rejected.json()["detail"]
    for route, default in (
        ("/auth/sessions", 200),
        ("/admin/users", 50),
        ("/admin/audit", 200),
        ("/admin/devices", 200),
    ):
        response = await client.get(prefix + route, params={"page": "", "pageSize": ""})
        assert response.status_code == 200, response.text
        assert (response.json()["page"], response.json()["pageSize"]) == (1, default)
        response = await client.get(prefix + route, params={"page": "0x2", "pageSize": "2e1"})
        assert response.status_code == 200, response.text
        assert (response.json()["page"], response.json()["pageSize"]) == (2, 20)
        assert (await client.get(prefix + route, params={"pageSize": 201})).status_code == 422
    authorization = await client.post(
        prefix + "/oauth/authorize",
        json={
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "agents-anywhere://oauth/callback",
            "code_challenge": "a" * 43,
        },
    )
    assert authorization.status_code == 422
    assert authorization.json()["detail"] == "response_type must be code"


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_setup_token_email_gate_is_limited_to_empty_database(
    platform: tuple[FastAPI, AsyncClient], prefix: str
) -> None:
    """仅兼容已有安全空库门禁；配置自动管理员完成后setup token绝不打开普通注册。"""
    app, client = platform
    accounts = app.state.services.accounts
    accounts.system.internal_settings = AsyncMock(
        return_value={
            "registrationOpen": False,
            "email": {
                "enabled": True,
                "fromAddress": "synthetic@example.invalid",
                "apiKey": "synthetic",
            },
        }
    )
    accounts.email.sender.send = AsyncMock()
    body = {"email": "new-member@example.invalid", "purpose": "register"}
    rejected = await client.post(
        prefix + "/auth/email-code", json={**body, "setupToken": "invalid"}
    )
    assert rejected.status_code == 403
    allowed = await client.post(
        prefix + "/auth/email-code", json={**body, "setupToken": "synthetic-setup-token"}
    )
    assert allowed.status_code == 200, allowed.text
    accounts.email.sender.send.assert_awaited_once()
    await bootstrap(client, prefix)
    client.headers.pop("Authorization")
    closed = await client.post(
        prefix + "/auth/email-code",
        json={**body, "email": "second@example.invalid", "setupToken": "synthetic-setup-token"},
    )
    assert closed.status_code == 403
    accounts.email.sender.send.assert_awaited_once()


async def test_oauth_new_account_uses_email_name_without_implicit_password_requirement(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """受控IdP通过真实回调和实库注册；旧表单不发送username/setPassword也能完成绑定。"""
    app, client = platform
    await bootstrap(client)
    configured = await client.patch(
        "/api/admin/settings",
        json={
            "oauthRegistrationOpen": True,
            "oauth": {
                "enabled": True,
                "provider": "synthetic",
                "clientId": "synthetic-client",
                "clientSecret": "synthetic-secret",
                "authorizeUrl": "https://synthetic.invalid/authorize",
                "tokenUrl": "https://synthetic.invalid/token",
                "userInfoUrl": "https://synthetic.invalid/user",
            },
        },
    )
    assert configured.status_code == 200, configured.text

    def provider(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            return httpx.Response(200, json={"access_token": "synthetic-provider-access"})
        return httpx.Response(
            200,
            json={"sub": "new-subject", "email": "new-oauth@example.invalid", "name": "合成新用户"},
        )

    app.state.services.accounts.external.transport = httpx.MockTransport(provider)
    start = await client.get("/api/auth/oauth/start")
    assert start.status_code == 200, start.text
    state = parse_qs(urlsplit(start.json()["authorizeUrl"]).query)["state"][0]
    callback = await client.get(
        "/api/auth/oauth/callback", params={"state": state, "code": "synthetic-code"}
    )
    assert callback.status_code == 302, callback.text
    parameters = parse_qs(urlsplit(callback.headers["location"]).query)
    assert parameters["oauth_status"] == ["needs_registration"]
    result = await client.post(
        "/api/auth/oauth/finalize",
        json={
            "pendingToken": parameters["oauth_pending"][0],
            "email": "new-oauth@example.invalid",
            "displayName": "合成新用户",
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["username"] == "new-oauth"
    assert result.json()["roles"] == ["member"]
