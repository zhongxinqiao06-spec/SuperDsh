"""真实迁移与隔离账号验证注销、重新领取和对象回收，完全使用合成邮箱。"""

import asyncio
import hashlib
from datetime import UTC, datetime
from unittest.mock import AsyncMock

from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text

from app.modules.conversations.entity.do.models import SessionRow as Conversation


async def test_confirm_erase_and_register_again(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    admin = await bootstrap(client)
    await client.patch("/api/admin/settings", json={"registrationOpen": True})
    sender = AsyncMock()
    services = app.state.services
    services.accounts.email.registration_sender = sender
    email = "closed@example.invalid"

    async def register():
        sent = await client.post(
            "/api/auth/email-code", json={"email": email, "purpose": "register"}
        )
        assert sent.status_code == 200, sent.text
        registered = await client.post(
            "/api/auth/register",
            json={
                "email": email,
                "product": "entertainment",
                "password": "Fixture-password-123!",
                "code": sender.send.await_args.args[2],
                "clientType": "native",
            },
        )
        assert registered.status_code == 200, registered.text
        return registered.json()

    first = await register()
    uid = first["userId"]
    auth = {"Authorization": "Bearer " + first["accessToken"]}
    owner = await services.identity.get_account(uid)
    project = await client.post("/api/studio/projects", json={"title": "私有短片"}, headers=auth)
    assert project.status_code == 200, project.text
    async with app.state.database.sessions.begin() as db:
        db.add(
            Conversation(
                id="private-session",
                owner_id=uid,
                connector_id="fixture-device",
                runtime_id="dsh",
                runtime_type="dsh",
                cwd="/synthetic",
                title="私有会话",
                status="idle",
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
        )
    account_file = await services.files.ingest(
        owner, "private.txt", b"synthetic private text", "text/plain"
    )
    admin_owner = await services.identity.get_account(admin["userId"])
    other_file = await services.files.ingest(
        admin_owner, "unrelated.txt", b"other data", "text/plain"
    )
    database = app.state.database
    async with database.engine.connect() as db:
        object_row = (
            await db.execute(
                text("SELECT storage_id, object_key FROM web_file_entries WHERE id=:id"),
                {"id": account_file["id"]},
            )
        ).one()
    physical = (
        await services.files.storage.get(object_row.storage_id)
    ).root / object_row.object_key
    assert physical.is_file()
    cleanup = app.state.erasure_cleanup
    workspace = cleanup.runtime_root / hashlib.sha256(uid.encode()).hexdigest() / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "private.txt").write_text("fixture")
    body = {"confirm": True, "accountId": uid}
    url = "/api/auth/me"
    assert (
        await client.request("DELETE", url, headers={"Authorization": ""}, json=body)
    ).status_code == 401
    assert (
        await client.request("DELETE", url, headers=auth, json={**body, "confirm": False})
    ).status_code == 422
    assert (
        await client.request(
            "DELETE", url, headers=auth, json={**body, "accountId": admin["userId"]}
        )
    ).status_code == 409
    assert (
        await client.request("DELETE", url, json={**body, "accountId": admin["userId"]})
    ).status_code == 409
    assert (await client.get(url, headers=auth)).status_code == 200
    async with database.owner_io(uid) as active:
        assert active
        result = await client.request("DELETE", url, headers=auth, json=body)
        assert result.status_code == 202, result.text
        await cleanup.drain_one(services.runtime)
        assert workspace.is_dir() and physical.is_file()
    async with database.owner_io(uid) as active:
        assert not active
    async with database.engine.begin() as db:
        await db.execute(
            text("UPDATE account_erasure_jobs SET retry_at=now() WHERE owner=:uid"), {"uid": uid}
        )
    assert (await client.get(url, headers=auth)).status_code == 401
    assert (await client.request("DELETE", url, headers=auth, json=body)).status_code == 401
    assert (
        await client.post("/api/auth/refresh", json={"refreshToken": first["refreshToken"]})
    ).status_code == 401
    assert (await services.files.read(admin_owner, str(other_file["id"])))[0] == b"other data"
    async with database.engine.connect() as db:
        for table, field in (
            ("users", "id"),
            ("billing_wallets", "user_id"),
            ("billing_credit_lots", "user_id"),
            ("billing_ledger_entries", "user_id"),
            ("auth_sessions", "user_id"),
            ("web_file_entries", "owner_id"),
            ("web_conversations", "owner_id"),
            ("studio_projects", "owner"),
            ("account_verification_codes", "owner_id"),
        ):
            assert not await db.scalar(
                text(f"SELECT 1 FROM {table} WHERE {field}=:uid"), {"uid": uid}
            )
        assert not await db.scalar(
            text("SELECT 1 FROM account_verification_limits WHERE key=:key"),
            {"key": hashlib.sha256(email.encode()).hexdigest()},
        )
    # 服务器线程与测试均可领取同一持久工作；回收明确只处理原账号的文件。
    async with asyncio.timeout(12):
        while physical.exists() or workspace.exists():
            await cleanup.drain_one(services.runtime)
            await asyncio.sleep(0.05)
    second = await register()
    assert second["userId"] != uid and second["registrationGrant"]["points"] == 40
    assert (await client.get(url)).status_code == 200
    async with database.engine.connect() as db:
        assert (
            await db.scalar(
                text(
                    "SELECT count(*) FROM billing_credit_lots WHERE user_id=:uid AND remaining=40"
                ),
                {"uid": second["userId"]},
            )
            == 1
        )
        assert not await db.scalar(
            text("SELECT manifest FROM account_erasure_jobs WHERE owner=:uid"), {"uid": uid}
        )
