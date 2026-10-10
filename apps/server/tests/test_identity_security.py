"""Security behavior against isolated SQLite; no accounts or device processes."""

import asyncio
import time
import uuid

from test_auth import admin_token, bearer, make_client

from agent_server.core.auth import create_user_access_token, user_access_claims


def member(client, admin, name="alice", roles=None):
    response = client.post(
        "/admin/users",
        headers=bearer(admin),
        json={
            "username": name,
            "displayName": name,
            "password": "initial-secret",
            **({"roles": roles} if roles else {}),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def sign_in(client, name="alice", password="initial-secret"):
    payload = {
        "identifier": name,
        "password": password,
        "clientType": "native",
        "clientName": "Test desktop",
    }
    response = client.post("/auth/login", json=payload)
    assert response.status_code == 200, response.text
    if response.json().get("resetRequired"):
        assert (
            client.post(
                "/auth/change-password",
                headers=bearer(response.json()["accessToken"]),
                json={"newPassword": password},
            ).status_code
            == 204
        )
        response = client.post("/auth/login", json=payload)
    return response.json()


def test_username_only_login_has_short_revocable_native_session(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    user = member(client, admin)
    login = sign_in(client)
    assert login["userId"] == user["userId"]
    assert login["email"] is None
    assert login["roles"] == ["member"]
    claims = user_access_claims(login["accessToken"])
    assert claims["sid"]
    assert 895 <= claims["exp"] - int(time.time()) <= 900
    assert login["refreshToken"]
    sessions = client.get(
        "/auth/sessions", headers=bearer(login["accessToken"])
    ).json()["sessions"]
    assert sessions[0]["current"] is True
    assert sessions[0]["clientName"] == "Test desktop"
    assert (
        client.delete(
            f"/auth/sessions/{sessions[0]['id']}", headers=bearer(login["accessToken"])
        ).status_code
        == 204
    )
    assert (
        client.get("/connectors", headers=bearer(login["accessToken"])).status_code
        == 401
    )
    assert (
        client.post(
            "/auth/refresh", json={"refreshToken": login["refreshToken"]}
        ).status_code
        == 401
    )


def test_browser_refresh_cookie_and_replay_revoke_session(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    assert "superdsh_refresh" in client.cookies
    login = client.post(
        "/auth/login", json={"identifier": "user1", "password": "secret"}
    )
    cookie = login.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert login.json().get("refreshToken") is None
    first = client.cookies.get("superdsh_refresh")
    refreshed = client.post("/auth/refresh", json={})
    assert refreshed.status_code == 200
    latest = client.cookies.get("superdsh_refresh")
    assert first != latest
    assert client.post("/auth/refresh", json={"refreshToken": first}).status_code == 401
    assert (
        client.post("/auth/refresh", json={"refreshToken": latest}).status_code == 401
    )
    assert (
        client.get(
            "/auth/me", headers=bearer(refreshed.json()["accessToken"])
        ).status_code
        == 401
    )
    # An independent login is unaffected by replay of another session.
    assert client.get("/auth/me", headers=bearer(token)).status_code == 200


def test_cookie_refresh_rejects_untrusted_origin(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    response = client.post(
        "/auth/refresh", json={}, headers={"Origin": "https://other.example"}
    )
    assert response.status_code == 403


def test_production_policy_rejects_sidless_tokens(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    uid = client.get("/auth/me", headers=bearer(admin)).json()["userId"]
    client.app.state.store.allow_legacy_test_tokens = False
    assert (
        client.get(
            "/auth/me", headers=bearer(create_user_access_token(uid))
        ).status_code
        == 401
    )
    assert client.get("/auth/me", headers=bearer(admin)).status_code == 200


def test_soft_delete_preserves_device_owner_and_restore_keeps_disabled(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    user = member(client, admin)
    login = sign_in(client)
    created = client.post(
        "/connectors",
        headers=bearer(login["accessToken"]),
        json={"name": "Private laptop"},
    ).json()
    device_id = created["connector"]["id"]
    assert (
        client.delete(
            f"/admin/users/{user['userId']}", headers=bearer(admin)
        ).status_code
        == 204
    )
    assert (
        client.get("/connectors", headers=bearer(login["accessToken"])).status_code
        == 401
    )
    preserved = asyncio.run(client.app.state.store.get_connector(device_id))
    assert preserved.userId == user["userId"]
    restored = client.post(
        f"/admin/users/{user['userId']}/restore", headers=bearer(admin), json={}
    )
    assert restored.json()["userId"] == user["userId"]
    assert restored.json()["disabled"] is True
    assert (
        client.patch(
            f"/admin/users/{user['userId']}",
            headers=bearer(admin),
            json={"disabled": False},
        ).status_code
        == 200
    )
    fresh = sign_in(client)
    assert (
        client.get(
            f"/connectors/{device_id}", headers=bearer(fresh["accessToken"])
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/auth/refresh", json={"refreshToken": login["refreshToken"]}
        ).status_code
        == 401
    )


def test_recovery_is_owner_held_and_admin_cannot_set_password(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    user = member(client, admin)
    login = sign_in(client)
    codes = client.post(
        "/auth/recovery-codes", headers=bearer(login["accessToken"]), json={}
    ).json()["codes"]
    assert len(codes) == 8
    assert (
        client.patch(
            f"/admin/users/{user['userId']}",
            headers=bearer(admin),
            json={"password": "admin-knows-this"},
        ).status_code
        == 409
    )
    assert client.post(
        f"/admin/users/{user['userId']}/password-reset", headers=bearer(admin), json={}
    ).json() == {"status": "recovery_required"}
    assert (
        client.get("/auth/me", headers=bearer(login["accessToken"])).status_code == 401
    )
    reset = {
        "identifier": "alice",
        "recoveryCode": codes[0],
        "newPassword": "owner-only-secret",
    }
    assert client.post("/auth/recovery/reset", json=reset).status_code == 204
    assert client.post("/auth/recovery/reset", json=reset).status_code == 401
    assert sign_in(client, password="owner-only-secret")["userId"] == user["userId"]


def test_custom_role_union_and_no_delegated_privilege_escalation(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    user = member(client, admin)
    role = client.post(
        "/admin/roles",
        headers=bearer(admin),
        json={
            "name": "Accounts operator",
            "permissions": ["users.read", "users.manage", "roles.manage"],
        },
    )
    assert role.status_code == 201, role.text
    rid = role.json()["id"]
    assert (
        client.patch(
            f"/admin/users/{user['userId']}",
            headers=bearer(admin),
            json={"roles": ["member", rid]},
        ).status_code
        == 200
    )
    actor = sign_in(client)
    assert set(actor["roles"]) == {"member", rid}
    assert (
        "sessions.run" in actor["permissions"]
        and "users.manage" in actor["permissions"]
    )
    denied = client.post(
        "/admin/roles",
        headers=bearer(actor["accessToken"]),
        json={"name": "Escalated", "permissions": ["settings.manage"]},
    )
    assert denied.status_code == 409
    denied = client.patch(
        f"/admin/users/{user['userId']}",
        headers=bearer(actor["accessToken"]),
        json={"roles": ["admin"]},
    )
    assert denied.status_code == 409
    assert (
        client.patch(
            "/admin/roles/admin",
            headers=bearer(admin),
            json={"name": "Changed", "permissions": []},
        ).status_code
        == 409
    )
    assert (
        client.delete("/admin/roles/member", headers=bearer(admin)).status_code == 409
    )


def test_role_changes_revoke_old_session_and_do_not_give_other_content(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    user = member(client, admin)
    login = sign_in(client)
    created = client.post(
        "/connectors", headers=bearer(login["accessToken"]), json={"name": "Private"}
    ).json()
    device_id = created["connector"]["id"]
    assert (
        client.get(f"/connectors/{device_id}", headers=bearer(admin)).status_code == 404
    )
    inventory = client.get("/admin/devices", headers=bearer(admin)).json()["devices"]
    assert inventory[0]["name"] == "Private"
    assert "userPreferences" not in inventory[0] and "sessions" not in inventory[0]
    assert (
        client.patch(
            f"/admin/users/{user['userId']}",
            headers=bearer(admin),
            json={"roles": ["admin"]},
        ).status_code
        == 200
    )
    assert (
        client.get("/auth/me", headers=bearer(login["accessToken"])).status_code == 401
    )
    assert (
        client.post(
            "/auth/refresh", json={"refreshToken": login["refreshToken"]}
        ).status_code
        == 401
    )


def test_persistent_device_block_rejects_reconnect_and_registration_retry(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    member(client, admin)
    login = sign_in(client)
    registration = {"name": "Laptop", "installationId": str(uuid.uuid4())}
    created = client.post(
        "/connectors", headers=bearer(login["accessToken"]), json=registration
    ).json()
    device_id = created["connector"]["id"]
    credential = {"Authorization": f"Connector {device_id}:{created['connectorToken']}"}
    access = client.post("/connector/auth", headers=credential).json()["accessToken"]
    blocked = client.post(
        f"/admin/devices/{device_id}/block",
        headers=bearer(admin),
        json={"reason": "Maintenance"},
    )
    assert blocked.status_code == 200, blocked.text
    assert client.post("/connector/auth", headers=credential).status_code == 401
    assert (
        asyncio.run(client.app.state.store.authenticate_connector_access(access))
        is None
    )
    assert (
        client.post(
            "/connectors", headers=bearer(login["accessToken"]), json=registration
        ).status_code
        == 409
    )
    listing = client.get("/connectors", headers=bearer(login["accessToken"])).json()[
        "connectors"
    ]
    assert listing[0]["blockedAt"] and listing[0]["blockedReason"] == "Maintenance"
    assert (
        client.post(
            f"/admin/devices/{device_id}/resume", headers=bearer(admin), json={}
        ).status_code
        == 200
    )
    assert client.post("/connector/auth", headers=credential).status_code == 200


def test_disabling_owner_also_denies_connector_credentials(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    user = member(client, admin)
    login = sign_in(client)
    created = client.post(
        "/connectors", headers=bearer(login["accessToken"]), json={"name": "Laptop"}
    ).json()
    credential = {
        "Authorization": f"Connector {created['connector']['id']}:{created['connectorToken']}"
    }
    assert client.post("/connector/auth", headers=credential).status_code == 200
    assert (
        client.patch(
            f"/admin/users/{user['userId']}",
            headers=bearer(admin),
            json={"disabled": True},
        ).status_code
        == 200
    )
    assert client.post("/connector/auth", headers=credential).status_code == 401


def test_email_recovery_uses_owner_code_once_and_revokes_session(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    user = client.get("/auth/me", headers=bearer(admin)).json()
    code = asyncio.run(
        client.app.state.store.issue_email_code(
            email=user["email"], purpose="reset", user_id=user["userId"]
        )
    )
    request = {"email": user["email"], "code": code, "newPassword": "new-owner-secret"}
    assert client.post("/auth/recovery/reset-email", json=request).status_code == 204
    assert client.get("/auth/me", headers=bearer(admin)).status_code == 401
    assert client.post("/auth/recovery/reset-email", json=request).status_code == 401
    assert (
        sign_in(client, name="user1", password="new-owner-secret")["userId"]
        == user["userId"]
    )


def test_initial_password_change_invalidates_pre_activation_recovery_codes(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    user = member(client, admin)
    assert user["resetRequired"] is True
    initial = client.post(
        "/auth/login",
        json={
            "identifier": "alice",
            "password": "initial-secret",
            "clientType": "native",
        },
    ).json()
    assert initial["resetRequired"] is True
    previous_codes = client.post(
        "/auth/recovery-codes", headers=bearer(initial["accessToken"]), json={}
    ).json()["codes"]
    assert (
        client.post(
            "/auth/change-password",
            headers=bearer(initial["accessToken"]),
            json={"newPassword": "owner-private-secret"},
        ).status_code
        == 204
    )
    assert (
        client.get("/auth/me", headers=bearer(initial["accessToken"])).status_code
        == 401
    )
    assert (
        client.post(
            "/auth/recovery/reset",
            json={
                "identifier": "alice",
                "recoveryCode": previous_codes[0],
                "newPassword": "attacker-secret",
            },
        ).status_code
        == 401
    )
    assert sign_in(client, password="owner-private-secret")["resetRequired"] is False


def test_alias_migration_preserves_immutable_user_and_connector_owner(
    tmp_path, monkeypatch
):
    from sqlalchemy import create_engine, text

    from agent_server.infra.db.migrations import upgrade_database

    path = tmp_path / "alias.sqlite3"
    url = f"sqlite+aiosqlite:///{path}"
    upgrade_database(db_url=url, revision="v2_35")
    engine = create_engine(f"sqlite:///{path}")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,password_hash,role,disabled,email,display_name,created_at,updated_at) VALUES ('usr_stable_owner','fixture','admin',0,'owner@example.test','Owner','2026-01-01','2026-01-01')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO connectors (id,user_id,name,status,token_hash,token_prefix,created_at,updated_at) VALUES ('conn_stable','usr_stable_owner','Laptop','offline','fixture','fixture','2026-01-01','2026-01-01')"
            )
        )
    monkeypatch.setenv("AGENT_SERVER_LOGIN_ALIAS", "admin")
    monkeypatch.setenv("AGENT_SERVER_LOGIN_EMAIL", "owner@example.test")
    upgrade_database(db_url=url)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT id,username FROM users")).one() == (
            "usr_stable_owner",
            "admin",
        )
        assert (
            conn.execute(
                text("SELECT user_id FROM connectors WHERE id='conn_stable'")
            ).scalar_one()
            == "usr_stable_owner"
        )
        assert (
            conn.execute(
                text("SELECT role_id FROM user_roles WHERE user_id='usr_stable_owner'")
            ).scalar_one()
            == "admin"
        )
    engine.dispose()


def test_rejected_role_update_does_not_partially_change_profile(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    user = member(client, admin)
    response = client.patch(
        f"/admin/users/{user['userId']}",
        headers=bearer(admin),
        json={
            "displayName": "Changed",
            "roles": ["role_missing"],
            "disabled": True,
        },
    )
    assert response.status_code == 409
    actual = asyncio.run(client.app.state.store.get_user(user["userId"]))
    assert actual.displayName == "alice" and not actual.disabled
    admin_id = client.get("/auth/me", headers=bearer(admin)).json()["userId"]
    assert (
        client.post(
            f"/admin/users/{admin_id}/restore", headers=bearer(admin), json={}
        ).status_code
        == 403
    )
    assert client.get("/auth/me", headers=bearer(admin)).status_code == 200


def test_concurrent_cross_demotion_keeps_an_active_administrator(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    first_id = client.get("/auth/me", headers=bearer(token)).json()["userId"]
    second = member(client, token, roles=["admin"])
    sign_in(client)
    db = client.app.state.store

    async def race():
        first = await db.get_user(first_id)
        other = await db.get_user(second["userId"])
        results = await asyncio.gather(
            db.update_user_admin(
                other.userId,
                actor=first,
                display_name=None,
                role_ids=["member"],
                disabled=None,
            ),
            db.update_user_admin(
                first.userId,
                actor=other,
                display_name=None,
                role_ids=["member"],
                disabled=None,
            ),
            return_exceptions=True,
        )
        active = await db.count_admins()
        return results, active

    results, active = asyncio.run(race())
    assert sum(isinstance(result, ValueError) for result in results) == 1
    assert active == 1


def test_legacy_email_registration_allocates_distinct_valid_login_names(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    assert (
        client.patch(
            "/admin/settings", headers=bearer(admin), json={"registrationOpen": True}
        ).status_code
        == 200
    )
    created = []
    for email in ("a+b@example.test", "a+b@another.test", "x@example.test"):
        response = client.post(
            "/auth/register",
            json={"email": email, "displayName": "Owner", "password": "owner-secret"},
        )
        assert response.status_code == 200, response.text
        created.append(response.json())
        assert (
            client.post(
                "/auth/login", json={"identifier": email, "password": "owner-secret"}
            ).status_code
            == 200
        )
    assert len({user["username"] for user in created}) == 3
    assert len({user["userId"] for user in created}) == 3
