"""用户注册切片的实库证据，复用合成邮件传输和独立 PostgreSQL。"""

import asyncio
from datetime import datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from conftest import bootstrap, upgrade_database
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.identity.service import account_service


async def test_registration_grant_is_atomic_and_shared(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    response = await client.patch(
        "/api/admin/settings", json={"registrationOpen": True}
    )
    assert response.status_code == 200
    body = {
        "email": "studio@example.invalid",
        "product": "entertainment",
        "password": "Synthetic-password-456!",
        "roles": ["admin"],
    }
    assert (await client.get("/api/auth/config")).json()[
        "registrationEmailAvailable"
    ] is False
    assert (await client.post("/api/auth/register", json=body)).status_code == 503
    sent = AsyncMock()
    app.state.services.accounts.email.sender = sent
    assert (
        await client.patch(
            "/api/admin/settings",
            json={
                "email": {
                    "enabled": True,
                    "fromAddress": "test@example.invalid",
                    "apiKey": "fixture-key",
                }
            },
        )
    ).status_code == 200
    email_request = {"email": body["email"], "purpose": "register"}
    issued = await client.post("/api/auth/email-code", json=email_request)
    assert issued.status_code == 200
    clock = {k: datetime.fromisoformat(v) for k, v in issued.json().items()}
    assert clock["expiresAt"] - clock["resendAt"] == timedelta(minutes=9)
    limited = await client.post("/api/auth/email-code", json=email_request)
    assert (
        limited.status_code == 429 and limited.json()["code"] == "verification_cooldown"
    )
    assert 0 < int(limited.headers["retry-after"]) <= 60
    body["code"] = sent.send.await_args.args[2]
    assert (
        await client.post("/api/auth/register", json={**body, "product": "admin"})
    ).status_code == 422
    with monkeypatch.context() as patch:
        patch.setattr(
            account_service,
            "grant_registration_credit",
            AsyncMock(side_effect=RuntimeError("synthetic ledger failure")),
        )
        with pytest.raises(RuntimeError, match="synthetic ledger failure"):
            await client.post("/api/auth/register", json=body)
    # 失败后原验证码可重试，同一邮箱同时命中新旧两个入口只能产生一次发放。
    results = await asyncio.gather(
        *(
            client.post(prefix + "/auth/register", json=body)
            for prefix in ["/api", "/api/v2"]
        )
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    user = next(r.json() for r in results if r.status_code == 200)
    assert user["roles"] == ["entertainment_creator"] and user["emailVerified"]
    async with app.state.database.engine.connect() as connection:
        row = (
            await connection.execute(
                text("""
            SELECT u.registration_product, u.email_verified_at, l.granted, l.remaining,
                   l.held, l.expires_at, e.available_delta, e.held_delta
            FROM users u JOIN billing_wallets w ON w.user_id = u.id
            JOIN billing_credit_lots l ON l.user_id = w.user_id
            JOIN billing_ledger_entries e ON e.lot_id = l.id WHERE u.id = :user
        """),
                {"user": user["userId"]},
            )
        ).one()
        assert (
            row.registration_product,
            row.granted,
            row.remaining,
            row.held,
            row.available_delta,
            row.held_delta,
        ) == ("entertainment", 200, 200, 0, 200, 0)
        assert user["registrationGrant"] == {
            "points": row.granted,
            "expiresAt": row.expires_at.isoformat(),
        }
        assert row.expires_at - row.email_verified_at == timedelta(days=30)
        assert (
            await connection.scalar(text("SELECT count(*) FROM billing_wallets"))
        ) == 1


async def test_challenge_expiry_replacement_and_lockout(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """用真实数据库时钟推进过期窗口，验证重发覆盖和尝试次数跨请求持久化。"""
    app, client = platform
    await bootstrap(client)
    await client.patch("/api/admin/settings", json={"registrationOpen": True})
    sender = AsyncMock()
    app.state.services.accounts.email.registration_sender = sender
    email = "retry@example.invalid"
    request = {"email": email, "purpose": "register"}
    body = {"email": email, "password": "Synthetic-password-456!"}
    await client.post("/api/auth/email-code", json=request)
    original = sender.send.await_args.args[2]
    async with app.state.database.engine.begin() as db:
        await db.execute(
            text(
                "UPDATE account_verification_codes SET sent_at=now()-interval '11 minutes', expires_at=now()-interval '1 minute'"
            )
        )
    expired = await client.post("/api/auth/register", json={**body, "code": original})
    assert expired.json()["code"] == "verification_code_expired"
    assert (await client.post("/api/auth/email-code", json=request)).status_code == 200
    latest = sender.send.await_args.args[2]
    wrong = original if original != latest else f"{(int(latest) + 1) % 1000000:06d}"
    for _ in range(4):
        result = await client.post("/api/auth/register", json={**body, "code": wrong})
        assert result.json()["code"] == "verification_code_incorrect"
    exhausted = await client.post("/api/auth/register", json={**body, "code": wrong})
    assert exhausted.json()["code"] == "verification_attempts_exhausted"
    assert 0 < int(exhausted.headers["retry-after"]) <= 3600
    assert (
        await client.post("/api/auth/register", json={**body, "code": latest})
    ).status_code == 429
    assert (await client.post("/api/auth/email-code", json=request)).json()[
        "code"
    ] == "verification_attempts_exhausted"


@pytest.mark.parametrize("platform_configuration", ["01bd73a6cae2"], indirect=True)
async def test_upgrade_preserves_existing_user(
    platform_configuration: Settings,
) -> None:
    """从上一实际 revision 安装数据，再升级并核对用户及未发放状态。"""
    url = platform_configuration.database_url
    engine = create_async_engine(url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text("""INSERT INTO users
                (id,username,password_hash,roles,disabled,reset_required,auth_version,revision)
                VALUES ('existing','existing','original','["member"]',false,false,0,1)""")
            )
        await upgrade_database(url)
        async with engine.connect() as connection:
            row = (
                await connection.execute(
                    text(
                        "SELECT password_hash, registration_product, email_verified_at FROM users WHERE id='existing'"
                    )
                )
            ).one()
            assert tuple(row) == ("original", None, None)
            assert (
                await connection.scalar(text("SELECT count(*) FROM billing_wallets"))
                == 0
            )
    finally:
        await engine.dispose()
