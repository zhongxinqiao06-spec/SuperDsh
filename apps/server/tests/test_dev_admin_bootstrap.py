"""Development initialization uses private temporary databases only."""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import delete, inspect, select, update
from sqlalchemy.exc import IntegrityError

from agent_server.infra.db.identity_schema import identity_audit, roles, user_roles
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.db.schema import users
from agent_server.infra.repositories.facade import Store
from scripts import bootstrap_dev_admin as bootstrap


@pytest.fixture(autouse=True)
def _isolate_external_database(monkeypatch):
    # Override the shared fixture's PostgreSQL truncation: these tests must not
    # connect to an inherited database, even when invoked from a configured shell.
    monkeypatch.delenv("AGENT_SERVER_DB_BACKEND", raising=False)
    monkeypatch.delenv("AGENT_SERVER_DB_URL", raising=False)
    monkeypatch.delenv("AGENT_SERVER_LOGIN_ALIAS", raising=False)
    monkeypatch.delenv("AGENT_SERVER_LOGIN_EMAIL", raising=False)


@pytest.fixture
def dev_database(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'development.sqlite3'}"
    upgrade_database(db_url=url)
    return url


async def snapshot(store):
    async with store.engine.connect() as connection:
        return [
            [dict(row) for row in (await connection.execute(select(table))).mappings()]
            for table in (users, user_roles, identity_audit)
        ]


async def create_account(store, username="admin", role="admin"):
    return await store.create_email_user(
        email=None,
        username=username,
        display_name=username,
        password="existing-private-password",
        role=role,
    )


def test_creates_login_with_admin_grants_and_audit(dev_database):
    async def scenario():
        store = Store(db_url=dev_database)
        try:
            assert await bootstrap.ensure_dev_admin(store) == "created"
            authenticated = await store.verify_email_user(
                email="admin", password="admin123"
            )
            assert authenticated is not None
            assert authenticated.userId.startswith("usr_")
            user = await store.get_user(authenticated.userId)
            assert user.username == "admin"
            assert user.roles == ["admin"]
            assert "users.manage" in user.permissions
            rows, grants, audit = await snapshot(store)
            assert len(rows) == 1
            assert grants == [{"user_id": user.userId, "role_id": "admin"}]
            assert len(audit) == 1
            assert audit[0]["action"] == "user.created"
            assert audit[0]["target_id"] == user.userId
            before = await snapshot(store)
            assert await bootstrap.ensure_dev_admin(store) == "keptexisting"
            assert await snapshot(store) == before
        finally:
            await store.close()

    asyncio.run(scenario())


def test_creates_admin_alongside_other_users_without_changing_them(dev_database):
    async def scenario():
        store = Store(db_url=dev_database)
        try:
            await create_account(store, "tri_admin", "admin")
            await create_account(store, "tri_owner", "member")
            before_users, before_grants, _ = await snapshot(store)
            assert await bootstrap.ensure_dev_admin(store) == "created"
            after_users, after_grants, _ = await snapshot(store)
            assert len(after_users) == 3
            assert all(row in after_users for row in before_users)
            assert all(row in after_grants for row in before_grants)
        finally:
            await store.close()

    asyncio.run(scenario())


def test_existing_admin_keeps_password_identity_and_all_fields(dev_database):
    async def scenario():
        store = Store(db_url=dev_database)
        try:
            existing = await create_account(store)
            before = await snapshot(store)
            assert await bootstrap.ensure_dev_admin(store) == "keptexisting"
            assert await bootstrap.ensure_dev_admin(store) == "keptexisting"
            assert await snapshot(store) == before
            authenticated = await store.verify_email_user(
                email="admin", password="existing-private-password"
            )
            assert authenticated.userId == existing.userId
            assert (
                await store.verify_email_user(email="admin", password="admin123")
                is None
            )
        finally:
            await store.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "role,changes",
    [
        ("member", {}),
        ("admin", {"disabled": 1}),
        ("admin", {"deleted_at": "2026-01-01T00:00:00Z", "disabled": 1}),
        ("admin", {"reset_required": 1}),
        ("admin", {"password_hash": "unusable"}),
        # Explicit grants override the compatibility role column.
        ("member", {"role": "admin"}),
    ],
)
def test_unavailable_admin_is_rejected_without_changes(dev_database, role, changes):
    async def scenario():
        store = Store(db_url=dev_database)
        try:
            user = await create_account(store, role=role)
            if changes:
                async with store.engine.begin() as connection:
                    await connection.execute(
                        update(users).where(users.c.id == user.userId).values(**changes)
                    )
            before = await snapshot(store)
            with pytest.raises(
                bootstrap.DevAdminBootstrapError, match="left unchanged"
            ):
                await bootstrap.ensure_dev_admin(store)
            assert await snapshot(store) == before
        finally:
            await store.close()

    asyncio.run(scenario())


def test_concurrent_creation_keeps_one_identity(dev_database, monkeypatch):
    async def scenario():
        store = Store(db_url=dev_database)
        try:
            create = store.create_email_user
            barrier = asyncio.Barrier(2)

            async def concurrent_create(**kwargs):
                await barrier.wait()
                return await create(**kwargs)

            monkeypatch.setattr(store, "create_email_user", concurrent_create)
            results = await asyncio.gather(
                bootstrap.ensure_dev_admin(store), bootstrap.ensure_dev_admin(store)
            )
            assert sorted(results) == ["created", "keptexisting"]
            accounts, grants, audit = await snapshot(store)
            assert len(accounts) == len(grants) == len(audit) == 1
        finally:
            await store.close()

    asyncio.run(scenario())


def test_existing_admin_without_role_mapping_is_rejected(dev_database):
    async def scenario():
        store = Store(db_url=dev_database)
        try:
            user = await create_account(store)
            async with store.engine.begin() as connection:
                await connection.execute(
                    delete(user_roles).where(user_roles.c.user_id == user.userId)
                )
            before = await snapshot(store)
            with pytest.raises(
                bootstrap.DevAdminBootstrapError, match="left unchanged"
            ):
                await bootstrap.ensure_dev_admin(store)
            assert await snapshot(store) == before
        finally:
            await store.close()

    asyncio.run(scenario())


def test_failed_creation_rolls_back_without_affecting_existing_data(dev_database):
    async def scenario():
        store = Store(db_url=dev_database)
        try:
            await create_account(store, "tri_owner", "member")
            # A broken role catalog makes the real Store transaction fail after
            # inserting the user, exercising its rollback rather than a mock.
            async with store.engine.begin() as connection:
                await connection.execute(delete(roles).where(roles.c.id == "admin"))
            before = await snapshot(store)
            with pytest.raises(ValueError) as raised:
                await bootstrap.ensure_dev_admin(store)
            assert isinstance(raised.value.__cause__, IntegrityError)
            assert await snapshot(store) == before
        finally:
            await store.close()

    asyncio.run(scenario())


def test_does_not_migrate_an_empty_database(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_SERVER_DB_BACKEND", raising=False)

    async def scenario():
        store = Store(db_url=f"sqlite+aiosqlite:///{tmp_path / 'empty.sqlite3'}")
        try:
            with pytest.raises(
                bootstrap.DevAdminBootstrapError, match="requires migration"
            ):
                await bootstrap.ensure_dev_admin(store)
            async with store.engine.connect() as connection:
                assert (
                    await connection.run_sync(
                        lambda sync: inspect(sync).get_table_names()
                    )
                    == []
                )
        finally:
            await store.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("flag", [None, "0", "true"])
def test_cli_requires_explicit_flag_without_connecting(monkeypatch, capsys, flag):
    monkeypatch.delenv("SUPERDSH_BOOTSTRAP_DEV_ADMIN", raising=False)
    if flag is not None:
        monkeypatch.setenv("SUPERDSH_BOOTSTRAP_DEV_ADMIN", flag)
    monkeypatch.setenv("AGENT_SERVER_DB_URL", "must-not-connect")
    assert bootstrap.main() == 1
    assert "SUPERDSH_BOOTSTRAP_DEV_ADMIN=1" in capsys.readouterr().err


def test_cli_requires_database_url(monkeypatch, capsys):
    monkeypatch.setenv("SUPERDSH_BOOTSTRAP_DEV_ADMIN", "1")
    monkeypatch.delenv("AGENT_SERVER_DB_URL", raising=False)
    assert bootstrap.main() == 1
    assert "requires AGENT_SERVER_DB_URL" in capsys.readouterr().err


def test_cli_reports_result_and_hides_driver_secrets(dev_database, monkeypatch, capsys):
    monkeypatch.setenv("SUPERDSH_BOOTSTRAP_DEV_ADMIN", "1")
    monkeypatch.setenv("AGENT_SERVER_DB_URL", dev_database)
    assert bootstrap.main() == 0
    assert capsys.readouterr().out == "created\n"
    assert bootstrap.main() == 0
    assert capsys.readouterr().out == "keptexisting\n"

    async def failed(_db_url):
        raise ValueError("driver-error-including-private-password-and-hash")

    monkeypatch.setattr(bootstrap, "_run", failed)
    assert bootstrap.main() == 1
    captured = capsys.readouterr()
    assert "ValueError" in captured.err
    assert "private-password" not in captured.err + captured.out
