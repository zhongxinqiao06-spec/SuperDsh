"""第二阶段身份与平台配置实库测试，邮件和提供方均为内存接收器。"""

import asyncio
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import httpx
from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient


class SyntheticMailbox:
    """只捕获本轮合成验证码，绝不发送外部邮件。"""

    def __init__(self) -> None:
        self.codes: dict[str, str] = {}

    async def send(self, configuration: dict[str, object], address: str, code: str) -> None:
        assert configuration["apiKey"] == "synthetic-mail-key"
        self.codes[address] = code


async def test_settings_email_registration_recovery_and_audit(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)
    mailbox = SyntheticMailbox()
    app.state.services.accounts.email.sender = mailbox
    settings = await client.patch(
        "/api/admin/settings",
        json={
            "revision": 0,
            "registrationOpen": True,
            "email": {
                "enabled": True,
                "fromAddress": "test@example.invalid",
                "apiKey": "synthetic-mail-key",
            },
        },
    )
    assert settings.status_code == 200, settings.text
    assert "synthetic-mail-key" not in settings.text
    assert settings.json()["email"]["apiKeyConfigured"]
    assert (
        await client.patch("/api/admin/settings", json={"revision": 0, "registrationOpen": False})
    ).status_code == 409
    assert (
        await client.patch("/api/admin/settings", json={"email": {"clearApiKey": True}})
    ).status_code == 422
    assert (
        await client.post(
            "/api/auth/email-code",
            json={"email": "new@example.invalid", "purpose": "register"},
        )
    ).status_code == 200
    assert (
        await client.post(
            "/api/auth/email-code",
            json={"email": "new@example.invalid", "purpose": "register"},
        )
    ).status_code == 429
    body = {
        "username": "newmember",
        "displayName": "测试成员",
        "email": "new@example.invalid",
        "password": "Synthetic-password-456!",
        "roles": ["admin"],
        "code": "bad",
    }
    assert (await client.post("/api/auth/register", json=body)).status_code == 422
    response = await client.post(
        "/api/auth/register",
        json={**body, "code": mailbox.codes["new@example.invalid"]},
    )
    assert response.status_code == 200, response.text
    member = {"Authorization": "Bearer " + response.json()["accessToken"]}
    assert response.json()["roles"] == ["member"]
    assert response.json()["emailVerified"] is True
    assert (
        await client.patch("/api/admin/settings", headers=member, json={"registrationOpen": False})
    ).status_code == 403
    assert (
        await client.put("/api/auth/me/profile", headers=member, json={"displayName": "新名称"})
    ).json()["displayName"] == "新名称"
    assert (
        await client.put(
            "/api/auth/me/username", headers=member, json={"username": "renamedmember"}
        )
    ).status_code == 200
    assert (
        await client.put(
            "/api/auth/me/avatar",
            headers=member,
            json={"avatar": "data:text/html;base64,PHNjcmlwdD4="},
        )
    ).status_code == 422
    assert (
        (
            await client.put(
                "/api/auth/me/avatar",
                headers=member,
                json={"avatar": "data:image/png;base64,aGVsbG8="},
            )
        )
        .json()["avatar"]
        .startswith("data:image/png")
    )
    assert (await client.delete("/api/auth/me/avatar", headers=member)).json()["avatar"] is None
    codes = (await client.post("/api/auth/recovery-codes", headers=member)).json()["codes"]
    assert len(codes) == len(set(codes)) == 8
    reset = {
        "identifier": "renamedmember",
        "recoveryCode": codes[0],
        "newPassword": "Synthetic-new-password-789!",
    }
    assert (await client.post("/api/auth/recovery/reset", json=reset)).status_code == 204
    assert (await client.post("/api/auth/recovery/reset", json=reset)).status_code == 401
    assert (await client.get("/api/auth/me", headers=member)).status_code == 401
    assert (
        await client.post(
            "/api/auth/login",
            json={
                "identifier": "renamedmember",
                "password": "Synthetic-new-password-789!",
            },
        )
    ).status_code == 200
    audit = (
        await client.get("/api/admin/audit", params={"search": "account.profile", "pageSize": 1})
    ).json()
    assert audit["total"] >= 3 and len(audit["events"]) == 1
    assert "synthetic-mail-key" not in str(audit)


async def test_mobile_confirmation_single_use_and_revocation(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    administrator = await bootstrap(client)
    qr = (await client.post("/api/auth/mobile-login/qr")).json()
    token = {
        "loginToken": qr["loginToken"],
        "userId": qr["userId"],
        "deviceName": "Synthetic Android",
    }
    assert (await client.post("/api/auth/mobile-login/exchange", json=token)).status_code == 401
    assert (
        await client.post("/api/auth/mobile-login/request", json={**token, "userId": "other"})
    ).status_code == 401
    assert (await client.post("/api/auth/mobile-login/request", json=token)).json()[
        "status"
    ] == "pending_web_confirm"
    assert (
        await client.post(
            "/api/auth/mobile-login/confirm",
            json={"loginToken": qr["loginToken"], "approved": True},
        )
    ).json()["status"] == "approved"
    results = await asyncio.gather(
        client.post("/api/auth/mobile-login/exchange", json=token),
        client.post("/api/auth/mobile-login/exchange", json=token),
    )
    assert sorted(response.status_code for response in results) == [200, 401]
    signed = next(response.json()["auth"] for response in results if response.status_code == 200)
    assert signed["userId"] == administrator["userId"] and signed["refreshToken"]
    assert (
        await client.post("/api/auth/mobile-login/status", json={"loginToken": qr["loginToken"]})
    ).json()["status"] == "consumed"
    qr = (await client.post("/api/auth/mobile-login/qr")).json()
    sessions = (await client.get("/api/auth/sessions")).json()["sessions"]
    current = next(row for row in sessions if row["current"])
    assert (await client.delete("/api/auth/sessions/" + current["id"])).status_code == 204
    assert (
        await client.post("/api/auth/mobile-login/status", json={"loginToken": qr["loginToken"]})
    ).status_code == 401


async def test_external_oauth_pkce_cookie_binding_and_one_use(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)
    assert (
        await client.post(
            "/api/admin/users",
            json={
                "username": "provideruser",
                "displayName": "合成供应商用户",
                "email": "provider@example.invalid",
                "password": "Synthetic-provider-password!",
            },
        )
    ).status_code == 201
    await complete_initial_login(client, "provideruser", "Synthetic-provider-password!")
    assert (
        await client.patch(
            "/api/admin/settings",
            json={
                "oauth": {
                    "enabled": True,
                    "provider": "synthetic",
                    "clientId": "fixture-client",
                    "clientSecret": "fixture-secret",
                    "authorizeUrl": "https://provider.invalid/authorize",
                    "tokenUrl": "https://provider.invalid/token",
                    "userInfoUrl": "https://provider.invalid/user",
                }
            },
        )
    ).status_code == 200
    exchanges: list[str] = []

    async def provider(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            values = parse_qs(request.content.decode())
            assert values["code_verifier"][0]
            assert values["redirect_uri"] == ["http://localhost:5175/api/auth/oauth/callback"]
            exchanges.append(values["code"][0])
            return httpx.Response(200, json={"access_token": "fixture-provider-token"})
        assert request.headers["authorization"] == "Bearer fixture-provider-token"
        return httpx.Response(
            200,
            json={
                "sub": "fixture-subject",
                "email": "provider@example.invalid",
                "name": "提供方用户",
            },
        )

    app.state.services.accounts.external.transport = httpx.MockTransport(provider)
    assert (
        await client.get("/api/auth/oauth/start", params={"returnTo": "https://attacker.invalid/"})
    ).status_code == 422
    start = (
        await client.get(
            "/api/auth/oauth/start", params={"returnTo": "http://localhost:5175/login"}
        )
    ).json()
    query = parse_qs(urlsplit(start["authorizeUrl"]).query)
    assert query["code_challenge_method"] == ["S256"]
    callback = await client.get(
        "/api/auth/oauth/callback",
        params={"state": query["state"][0], "code": "fixture-code"},
    )
    assert callback.status_code == 302, callback.text
    response = parse_qs(urlsplit(callback.headers["location"]).query)
    assert response["oauth_status"] == ["needs_password"]
    pending = response["oauth_pending"][0]
    replay = await client.get(
        "/api/auth/oauth/callback",
        params={"state": query["state"][0], "code": "fixture-code"},
    )
    assert replay.status_code == 302
    assert parse_qs(urlsplit(replay.headers["location"]).query)["oauth_error"] == [
        "invalid oauth state"
    ]
    assert exchanges == ["fixture-code"]
    assert (
        await client.post(
            "/api/auth/oauth/finalize",
            json={
                "pendingToken": pending,
                "email": "provider@example.invalid",
                "password": "wrong",
            },
        )
    ).status_code == 401
    finalized = await client.post(
        "/api/auth/oauth/finalize",
        json={
            "pendingToken": pending,
            "email": "provider@example.invalid",
            "password": "Synthetic-provider-password!",
        },
    )
    assert finalized.status_code == 200, finalized.text
    assert finalized.json()["username"] == "provideruser"
    assert (
        await client.post("/api/auth/oauth/finalize", json={"pendingToken": pending})
    ).status_code == 401


async def test_announcement_dashboard_permissions_and_timezones(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _app, client = platform
    await bootstrap(client)
    first = (
        await client.put(
            "/api/admin/announcement",
            json={"enabled": True, "markdown": "# 合成公告", "revision": 0},
        )
    ).json()
    same = (
        await client.put(
            "/api/admin/announcement",
            json={
                "enabled": True,
                "markdown": "# 合成公告",
                "revision": first["revision"],
            },
        )
    ).json()
    assert same["publishedAt"] == first["publishedAt"]
    changed = (
        await client.put(
            "/api/admin/announcement",
            json={
                "enabled": True,
                "markdown": "# 新公告",
                "revision": same["revision"],
            },
        )
    ).json()
    assert changed["publishedAt"] > same["publishedAt"]
    assert (await client.get("/api/announcement")).json()["announcement"]["markdown"] == "# 新公告"
    assert (
        await client.put(
            "/api/admin/announcement",
            json={"enabled": False, "markdown": "", "revision": 0},
        )
    ).status_code == 409
    today = datetime.now(UTC).date().isoformat()
    overview = await client.get(
        "/api/admin/dashboard/overview",
        params={"from": today, "to": today, "tz": "UTC"},
    )
    assert overview.status_code == 200, overview.text
    assert overview.json()["summary"]["totalUsers"] == 1
    assert (
        await client.get(
            "/api/admin/dashboard/overview",
            params={"from": today, "to": today, "tz": "invalid/zone"},
        )
    ).status_code == 422
    assert (
        await client.post("/api/admin/dashboard/snapshots/today", params={"tz": "UTC"})
    ).status_code == 200
    changed_settings = await client.patch(
        "/api/admin/dashboard/settings",
        json={"intensity": {"basis": "messages", "lightMax": 20, "mediumMax": 5}},
    )
    assert changed_settings.status_code == 200, changed_settings.text
    assert changed_settings.json()["intensity"] == {
        "basis": "messages",
        "lightMax": 20,
        "mediumMax": 20,
    }
    bins = changed_settings.json()["histogramBins"]
    patch = await client.patch("/api/admin/dashboard/settings", json={"intensity": {"lightMax": 8}})
    assert patch.status_code == 200, patch.text
    assert patch.json()["histogramBins"] == bins
    empty = await client.patch("/api/admin/dashboard/settings", json={})
    assert empty.json()["intensity"] == patch.json()["intensity"]
    period = await client.get(
        "/api/admin/dashboard/overview", params={"to": "2025-04-19", "tz": ""}
    )
    assert period.status_code == 200, period.text
    assert period.json()["range"] == {
        "fromDate": "2025-03-21",
        "toDate": "2025-04-19",
        "timezone": "Asia/Shanghai",
    }
    assert (
        await client.post("/api/admin/dashboard/snapshots/2025-04-19", params={"tz": ""})
    ).status_code == 200


async def test_dashboard_daily_activity_histograms_and_historical_snapshot(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """统计用户发送与每日活跃会话，快照缓存/显式重算均有真实PG证据。"""
    app, client = platform
    await bootstrap(client)
    facts: dict[str, object] = {
        "users": [
            {"userId": value, "createdAt": "2025-01-01T00:00:00Z"}
            for value in ("a", "b", "inactive")
        ],
        "sessions": [
            {
                "userId": "a",
                "id": "conversation",
                "agentType": "dsh",
                "createdAt": "2025-01-01T01:00:00Z",
            }
        ],
        "messages": [
            {"userId": "a", "sessionId": "conversation", "agentType": "dsh", "createdAt": value}
            for value in ("2025-01-02T01:00:00Z", "2025-01-02T02:00:00Z", "2025-01-03T01:00:00Z")
        ],
        "logins": [{"userId": "b", "createdAt": "2025-01-02T03:00:00Z"}],
        "devices": [{"deviceOs": "windows"}, {"deviceOs": "linux"}],
        "runtimes": [
            {"connectorId": "one", "type": "dsh"},
            {"connectorId": "two", "type": "codex"},
        ],
    }

    async def provider(*args: object) -> dict[str, object]:
        return facts

    app.state.services.system.facts_provider = provider
    query = {"from": "2025-01-02", "to": "2025-01-03", "tz": "UTC"}
    response = await client.get("/api/admin/dashboard/overview", params=query)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["summary"]["totalMessages"] == 1
    assert value["series"][0]["avgMessagesPerActiveUser"] == 1
    assert value["summary"]["activeSessions"] == 1
    assert (
        sum(bucket["count"] for bucket in value["messageHistogram"]) == 2
    )  # 不把从未活跃用户塞进分布。
    assert value["settings"]["histogramBins"]["sessions"] == [0, 2]  # 同会话跨日按每日活跃计数。
    assert next(item for item in value["agentBreakdown"] if item["key"] == "codex")["value"] == 1
    assert next(item for item in value["deviceBreakdown"] if item["key"] == "windows")["value"] == 1
    facts["messages"] = []
    cached = (await client.get("/api/admin/dashboard/overview", params=query)).json()
    assert cached["series"] == value["series"]
    snapshot = await client.post("/api/admin/dashboard/snapshots/2025-01-02", params={"tz": "UTC"})
    assert snapshot.status_code == 200, snapshot.text
    assert snapshot.json()["computedAt"] and snapshot.json()["users"] == 1
    assert snapshot.json()["metrics"] > 20
    refreshed = (await client.get("/api/admin/dashboard/overview", params=query)).json()
    assert refreshed["series"][0]["totalMessages"] == 0
    assert refreshed["series"][1]["totalMessages"] == 1
