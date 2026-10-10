"""An optional local login alias preserves the existing email account and permissions."""

from __future__ import annotations

import asyncio

import pytest
from test_auth import bearer, make_client, password_verifier, register


@pytest.fixture
def alias_account(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    created = register(client, "owner@example.test").json()
    monkeypatch.setenv("AGENT_SERVER_LOGIN_ALIAS", "admin")
    monkeypatch.setenv("AGENT_SERVER_LOGIN_EMAIL", created["email"])
    return client, created


@pytest.mark.parametrize("identifier", ["admin", " ADMIN ", "owner@example.test"])
def test_alias_preserves_account_and_admin_access(alias_account, identifier):
    client, created = alias_account
    response = client.post(
        "/auth/login", json={"email": identifier, "password": "secret"}
    )
    assert response.status_code == 200
    logged = response.json()
    assert logged["userId"] == created["userId"]
    assert logged["email"] == created["email"]
    assert logged["role"] == "admin"
    assert client.get("/admin/users", headers=bearer(logged["accessToken"])).status_code == 200


def test_alias_supports_browser_password_verifier(alias_account):
    client, created = alias_account
    alias_salt = client.post("/auth/password-salt", json={"email": "admin"}).json()["salt"]
    email_salt = client.post("/auth/password-salt", json={"email": created["email"]}).json()["salt"]
    assert alias_salt == email_salt
    response = client.post(
        "/auth/login",
        json={"email": "admin", "passwordVerifier": password_verifier("secret", alias_salt)},
    )
    assert response.status_code == 200
    assert response.json()["userId"] == created["userId"]


def test_alias_does_not_bypass_password_or_disabled_account(alias_account):
    client, created = alias_account
    assert client.post(
        "/auth/login", json={"email": "admin", "password": "wrong"}
    ).status_code == 401
    second_admin = client.post(
        "/admin/users",
        headers=bearer(created["accessToken"]),
        json={
            "email": "second@example.test",
            "displayName": "Second admin",
            "password": "secret",
            "role": "admin",
        },
    )
    assert second_admin.status_code == 201
    asyncio.run(client.app.state.store.set_user_disabled(created["userId"], True))
    assert client.post(
        "/auth/login", json={"email": "admin", "password": "secret"}
    ).status_code == 401


def test_alias_is_opt_in_and_does_not_enable_arbitrary_usernames(alias_account, monkeypatch):
    client, _created = alias_account
    assert client.post(
        "/auth/login", json={"email": "someone", "password": "secret"}
    ).status_code == 422
    monkeypatch.delenv("AGENT_SERVER_LOGIN_EMAIL")
    assert client.post(
        "/auth/login", json={"email": "admin", "password": "secret"}
    ).status_code == 422


def test_alias_does_not_relax_registration_email_validation(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_SERVER_LOGIN_ALIAS", "admin")
    monkeypatch.setenv("AGENT_SERVER_LOGIN_EMAIL", "owner@example.test")
    client = make_client(tmp_path)
    client.get("/auth/config")
    response = client.post(
        "/auth/register",
        json={
            "email": "admin",
            "displayName": "Owner",
            "password": "secret",
            "setupToken": client.app.state.setup_token.peek(),
        },
    )
    assert response.status_code == 422
    assert client.get("/auth/config").json()["needsBootstrap"] is True
