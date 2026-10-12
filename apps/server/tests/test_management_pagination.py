"""Paged management queries use private SQLite fixtures and preserve ownership."""

import asyncio

from sqlalchemy import insert
from test_auth import admin_token, bearer, make_client

from agent_server.infra.db.identity_schema import auth_sessions, identity_audit
from agent_server.infra.db.schema import connectors, users

STAMP = "2020-01-01T00:00:00Z"


def seed(client, table, rows):
    async def write():
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(insert(table), rows)

    asyncio.run(write())


def seed_users(client, count=61):
    seed(
        client,
        users,
        [
            {
                "id": f"paged-user-{index:03}",
                "username": f"paged{index:03}",
                "password_hash": "fixture-unused-password-hash",
                "display_name": f"Paged User {index:03}",
                "created_at": STAMP,
                "updated_at": STAMP,
            }
            for index in range(count)
        ],
    )


def test_users_query_full_database_and_keep_stable_page_order(tmp_path):
    client = make_client(tmp_path)
    headers = bearer(admin_token(client))
    seed_users(client)
    first = client.get(
        "/admin/users", headers=headers, params={"pageSize": 25, "search": "PAGED"}
    ).json()
    last = client.get(
        "/admin/users",
        headers=headers,
        params={"page": 3, "pageSize": 25, "search": "PAGED"},
    ).json()
    assert (first["total"], first["page"], first["pageSize"]) == (61, 1, 25)
    assert [user["userId"] for user in last["users"]] == [
        f"paged-user-{index:03}" for index in range(50, 61)
    ]
    assert first["users"][0]["permissions"]
    searched = client.get(
        "/admin/users", headers=headers, params={"search": "paged060"}
    ).json()
    assert searched["total"] == 1
    assert searched["users"][0]["userId"] == "paged-user-060"
    assert (
        client.get("/admin/users", headers=headers, params={"search": "%_"}).json()[
            "total"
        ]
        == 0
    )
    bounded = client.get(
        "/admin/users", headers=headers, params={"page": 0, "pageSize": 5000}
    ).json()
    assert (bounded["page"], bounded["pageSize"]) == (1, 200)


def test_devices_page_and_search_do_not_expose_execution_secrets(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    headers = bearer(token)
    owner = client.get("/auth/me", headers=headers).json()["userId"]
    seed(
        client,
        connectors,
        [
            {
                "id": f"device-{index:03}",
                "user_id": owner,
                "name": f"Computer {index:03}",
                "status": "offline",
                "device_os": "Windows",
                "token_hash": "hidden-device-secret",
                "token_prefix": "hidden-prefix",
                "user_preferences": '{"private": "hidden-content"}',
                "revoked": 1 if index == 61 else 0,
                "created_at": STAMP,
                "updated_at": STAMP,
            }
            for index in range(62)
        ],
    )
    response = client.get(
        "/admin/devices", headers=headers, params={"page": 3, "pageSize": 25}
    )
    result = response.json()
    assert (result["total"], result["page"], result["pageSize"]) == (61, 3, 25)
    assert [row["id"] for row in result["devices"]] == [
        f"device-{index:03}" for index in range(50, 61)
    ]
    assert "hidden-" not in response.text
    assert all(row["status"] == "offline" for row in result["devices"])
    # Older clients still receive their full inventory without opting into paging.
    assert len(client.get("/admin/devices", headers=headers).json()["devices"]) == 61
    searched = client.get(
        "/admin/devices", headers=headers, params={"page": 1, "search": "060"}
    ).json()
    assert searched["total"] == 1
    assert searched["devices"][0]["id"] == "device-060"


def test_audit_can_page_and_search_beyond_previous_200_event_limit(tmp_path):
    client = make_client(tmp_path)
    headers = bearer(admin_token(client))
    seed(
        client,
        identity_audit,
        [
            {
                "id": f"event-{index:03}",
                "actor_id": "operator",
                "action": "fixture.updated",
                "target_id": f"target-{index:03}",
                "detail_json": "{}",
                "created_at": STAMP,
            }
            for index in range(235)
        ],
    )
    old = client.get("/admin/audit", headers=headers).json()
    assert len(old["events"]) == 200
    assert old["total"] == 235
    last = client.get(
        "/admin/audit", headers=headers, params={"page": 10, "pageSize": 25}
    ).json()
    assert [row["id"] for row in last["events"]] == [
        f"event-{index:03}" for index in range(225, 235)
    ]
    searched = client.get(
        "/admin/audit", headers=headers, params={"page": 1, "search": "target-234"}
    ).json()
    assert searched["total"] == 1
    assert searched["events"][0]["id"] == "event-234"
    assert (
        client.get("/admin/audit", headers=headers, params={"page": 99}).json()[
            "events"
        ]
        == []
    )


def test_login_pages_keep_only_owned_live_sessions_and_current_marker(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    headers = bearer(token)
    owner = client.get("/auth/me", headers=headers).json()["userId"]
    seed_users(client, 1)
    seed(
        client,
        auth_sessions,
        [
            {
                "id": f"login-{index:03}",
                "user_id": "paged-user-000" if index == 61 else owner,
                "refresh_hash": f"hidden-refresh-{index}",
                "auth_version": 0,
                "client_name": f"Android {index:03}",
                "created_at": STAMP,
                "last_seen_at": STAMP,
                "expires_at": STAMP if index == 62 else "2100-01-01T00:00:00Z",
                "revoked_at": STAMP if index == 63 else None,
            }
            for index in range(64)
        ],
    )
    result = client.get(
        "/auth/sessions",
        headers=headers,
        params={"page": 3, "pageSize": 25, "search": "ANDROID"},
    )
    body = result.json()
    assert (body["total"], body["page"], body["pageSize"]) == (61, 3, 25)
    assert [row["id"] for row in body["sessions"]] == [
        f"login-{index:03}" for index in range(50, 61)
    ]
    assert "refresh" not in result.text
    legacy = client.get("/auth/sessions", headers=headers).json()
    assert len(legacy["sessions"]) == 62
    assert len([row for row in legacy["sessions"] if row["current"]]) == 1
    denied_search = client.get(
        "/auth/sessions", headers=headers, params={"page": 1, "search": "061"}
    ).json()
    assert denied_search["total"] == 0
    # Revoking a row changes both the total and page contents immediately.
    assert client.delete("/auth/sessions/login-060", headers=headers).status_code == 204
    assert (
        client.get(
            "/auth/sessions", headers=headers, params={"page": 1, "search": "Android"}
        ).json()["total"]
        == 60
    )


def test_management_pagination_keeps_endpoint_authorization(tmp_path):
    client = make_client(tmp_path)
    admin_token(client)
    seed_users(client, 1)
    login = asyncio.run(client.app.state.store.issue_login("paged-user-000"))
    headers = bearer(login["accessToken"])
    for path in ("/admin/users", "/admin/devices", "/admin/audit"):
        assert client.get(path, headers=headers, params={"page": 1}).status_code == 403
        assert client.get(path, params={"page": 1}).status_code == 401
