"""Menu APIs use temporary SQLite and real permission checks, never user data."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest
from test_auth import admin_token, bearer, make_client
from test_identity_security import member, sign_in

from agent_server.core.navigation import MODULE_BY_ID
from agent_server.infra.repositories.navigation import MenuVersionConflict


@pytest.fixture
def navigation_account(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_SERVER_DB_URL", raising=False)
    monkeypatch.delenv("AGENT_SERVER_REDIS_URL", raising=False)
    client = make_client(tmp_path)
    token = admin_token(client)
    return client, bearer(token)


def configuration(client, headers):
    response = client.get("/api/v2/admin/menus", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    return {"version": body["version"], "items": body["items"]}


def item(payload, key):
    return next(node for node in payload["items"] if node["id"] == key)


def page_ids(response):
    assert response.status_code == 200, response.text
    return {
        node["moduleId"] for node in response.json()["items"] if node["kind"] == "page"
    }


def create_role(client, headers, permissions):
    response = client.post(
        "/admin/roles",
        headers=headers,
        json={
            "name": "Menu auditor",
            "permissions": permissions,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_catalog_and_navigation_are_authenticated_and_permission_filtered(
    navigation_account,
):
    client, headers = navigation_account
    assert client.get("/api/v2/navigation").status_code == 401
    assert client.get("/api/v2/admin/menus").status_code == 401
    assert (
        page_ids(client.get("/api/v2/navigation", headers=headers))
        == MODULE_BY_ID.keys()
    )
    catalog = client.get("/api/v2/admin/menus", headers=headers)
    assert catalog.headers["cache-control"] == "no-store"
    assert {entry["id"] for entry in catalog.json()["modules"]} == MODULE_BY_ID.keys()
    assert {entry["id"] for entry in catalog.json()["roles"]} == {"admin", "member"}

    member(client, headers["Authorization"].removeprefix("Bearer "))
    regular = bearer(sign_in(client)["accessToken"])
    assert page_ids(client.get("/api/v2/navigation", headers=regular)) == {
        "overview",
        "workbench",
        "account.profile",
        "account.security",
        "account.models",
        "account.appearance",
        "account.mobile",
    }
    assert client.get("/api/v2/admin/menus", headers=regular).status_code == 403
    assert (
        client.put(
            "/api/v2/admin/menus", headers=regular, json=configuration(client, headers)
        ).status_code
        == 403
    )


def test_menu_edit_persists_and_visibility_never_grants_authority(navigation_account):
    client, headers = navigation_account
    member(client, headers["Authorization"].removeprefix("Bearer "))
    regular = bearer(sign_in(client)["accessToken"])
    payload = configuration(client, headers)
    item(payload, "models")["roleIds"] = ["member"]
    item(payload, "overview")["roleIds"] = ["admin"]
    item(payload, "account")["visible"] = False
    item(payload, "devices")["title"] = "设备状态"
    result = client.put("/api/v2/admin/menus", headers=headers, json=payload)
    assert result.status_code == 200, result.text
    assert result.json()["version"] == payload["version"] + 1
    assert configuration(client, headers)["items"] == payload["items"]
    assert page_ids(client.get("/api/v2/navigation", headers=regular)) == {"workbench"}
    assert (
        client.get("/api/v2/admin/models/providers", headers=regular).status_code == 403
    )
    # Hiding navigation does not remove backend authorization or the recovery API.
    assert client.get("/api/v2/auth/sessions", headers=regular).status_code == 200
    restored = client.post(
        "/api/v2/admin/menus/reset",
        headers=headers,
        json={"version": result.json()["version"]},
    )
    assert restored.status_code == 200, restored.text
    assert item(restored.json(), "devices")["title"] == "设备运维"
    audit = client.get("/admin/audit", headers=headers).json()["events"]
    events = {
        entry["action"]: entry for entry in audit if entry["action"].startswith("menu.")
    }
    assert events["menu.updated"]["detail"] == {"previousVersion": 1, "version": 2}
    assert events["menu.reset"]["detail"] == {"previousVersion": 2, "version": 3}


def test_groups_can_be_created_reordered_and_deleted(navigation_account):
    client, headers = navigation_account
    payload = configuration(client, headers)
    payload["items"].append(
        {
            "id": "operations",
            "kind": "group",
            "moduleId": None,
            "parentId": None,
            "title": "运维",
            "icon": "folder",
            "order": 2,
            "visible": True,
            "roleIds": [],
        }
    )
    item(payload, "devices")["parentId"] = "operations"
    result = client.put("/api/v2/admin/menus", headers=headers, json=payload)
    assert result.status_code == 200, result.text
    payload = configuration(client, headers)
    item(payload, "devices")["parentId"] = None
    payload["items"] = [node for node in payload["items"] if node["id"] != "operations"]
    result = client.put("/api/v2/admin/menus", headers=headers, json=payload)
    assert result.status_code == 200, result.text


def test_admin_can_recover_when_every_navigation_entry_is_hidden(navigation_account):
    client, headers = navigation_account
    payload = configuration(client, headers)
    for node in payload["items"]:
        node["visible"] = False
    result = client.put("/api/v2/admin/menus", headers=headers, json=payload)
    assert result.status_code == 200, result.text
    assert client.get("/api/v2/navigation", headers=headers).json()["items"] == []
    assert client.get("/api/v2/admin/menus", headers=headers).status_code == 200
    restored = client.post(
        "/api/v2/admin/menus/reset",
        headers=headers,
        json={"version": result.json()["version"]},
    )
    assert restored.status_code == 200, restored.text
    assert (
        page_ids(client.get("/api/v2/navigation", headers=headers))
        == MODULE_BY_ID.keys()
    )


@pytest.mark.parametrize(
    "invalid",
    [
        "duplicate",
        "unknown-role",
        "duplicate-role",
        "icon",
        "unknown-module",
        "changed-id",
        "deleted-page",
        "group-module",
        "missing-parent",
        "page-parent",
        "nested-group",
        "cycle",
        "blank-title",
        "script-path",
        "negative-order",
        "unexpected-route",
    ],
)
def test_invalid_menus_do_not_change_configuration_or_audit(
    navigation_account, invalid
):
    client, headers = navigation_account
    original = configuration(client, headers)
    payload = deepcopy(original)
    node = item(payload, "overview")
    if invalid == "duplicate":
        payload["items"].append(deepcopy(node))
    elif invalid == "unknown-role":
        node["roleIds"] = ["missing"]
    elif invalid == "duplicate-role":
        node["roleIds"] = ["admin", "admin"]
    elif invalid == "icon":
        node["icon"] = "https://evil.test/icon.svg"
    elif invalid == "unknown-module":
        node["moduleId"] = "unknown"
    elif invalid == "changed-id":
        node["id"] = "other"
    elif invalid == "deleted-page":
        payload["items"].remove(node)
    elif invalid == "group-module":
        item(payload, "account")["moduleId"] = "overview"
    elif invalid == "missing-parent":
        node["parentId"] = "missing"
    elif invalid == "page-parent":
        node["parentId"] = "models"
    elif invalid == "nested-group":
        item(payload, "account")["parentId"] = "system"
    elif invalid == "cycle":
        item(payload, "account")["parentId"] = "system"
        item(payload, "system")["parentId"] = "account"
    elif invalid == "blank-title":
        node["title"] = " "
    elif invalid == "script-path":
        node["id"] = "javascript:alert(1)"
    elif invalid == "negative-order":
        node["order"] = -1
    else:
        node["route"] = "#/unregistered"
    result = client.put("/api/v2/admin/menus", headers=headers, json=payload)
    assert result.status_code == 422, result.text
    assert configuration(client, headers) == original
    assert not [
        event
        for event in client.get("/admin/audit", headers=headers).json()["events"]
        if event["action"].startswith("menu.")
    ]


def test_custom_menu_reader_has_catalog_but_cannot_write(navigation_account):
    client, headers = navigation_account
    role_id = create_role(client, headers, ["menus.read"])
    member(client, headers["Authorization"].removeprefix("Bearer "), roles=[role_id])
    reader = bearer(sign_in(client)["accessToken"])
    result = client.get("/api/v2/admin/menus", headers=reader)
    assert result.status_code == 200, result.text
    assert {role["id"] for role in result.json()["roles"]} == {
        "admin",
        "member",
        role_id,
    }
    assert client.get("/admin/roles", headers=reader).status_code == 403
    assert "access.menus" in page_ids(client.get("/api/v2/navigation", headers=reader))
    assert (
        client.post(
            "/api/v2/admin/menus/reset",
            headers=reader,
            json={"version": result.json()["version"]},
        ).status_code
        == 403
    )


def test_custom_menu_manager_cannot_change_pages_above_their_authority(
    navigation_account,
):
    client, headers = navigation_account
    role_id = create_role(client, headers, ["menus.manage"])
    member(client, headers["Authorization"].removeprefix("Bearer "), roles=[role_id])
    manager = bearer(sign_in(client)["accessToken"])
    payload = configuration(client, manager)
    item(payload, "models")["visible"] = False
    assert (
        client.put("/api/v2/admin/menus", headers=manager, json=payload).status_code
        == 403
    )
    payload = configuration(client, manager)
    item(payload, "access")["title"] = "隐藏上级权限"
    assert (
        client.put("/api/v2/admin/menus", headers=manager, json=payload).status_code
        == 403
    )
    payload = configuration(client, manager)
    item(payload, "access.menus")["title"] = "导航配置"
    assert (
        client.put("/api/v2/admin/menus", headers=manager, json=payload).status_code
        == 200
    )


def test_concurrent_writes_and_reset_use_compare_and_swap(navigation_account):
    client, headers = navigation_account
    original = configuration(client, headers)
    payloads = [deepcopy(original), deepcopy(original)]
    for index, payload in enumerate(payloads):
        item(payload, "overview")["title"] = f"总览 {index}"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda payload: client.put(
                    "/api/v2/admin/menus", headers=headers, json=payload
                ),
                payloads,
            )
        )
    assert sorted(response.status_code for response in results) == [200, 409]
    winner = next(
        response.json() for response in results if response.status_code == 200
    )
    assert configuration(client, headers) == {"version": 2, "items": winner["items"]}
    assert (
        client.post(
            "/api/v2/admin/menus/reset",
            headers=headers,
            json={"version": original["version"]},
        ).status_code
        == 409
    )


def test_write_rechecks_actor_after_role_change(navigation_account):
    client, headers = navigation_account
    role_id = create_role(client, headers, ["menus.manage"])
    created = member(
        client, headers["Authorization"].removeprefix("Bearer "), roles=[role_id]
    )
    sign_in(client)
    db = client.app.state.store
    actor = asyncio.run(db.get_user(created["userId"]))
    assert (
        client.patch(
            f"/admin/roles/{role_id}",
            headers=headers,
            json={"name": "Revoked manager", "permissions": []},
        ).status_code
        == 200
    )
    payload = configuration(client, headers)
    with pytest.raises(PermissionError):
        asyncio.run(
            db.save_navigation(
                version=payload["version"], items=payload["items"], actor=actor
            )
        )
    assert configuration(client, headers) == payload


def test_stale_repository_version_does_not_append_audit(navigation_account):
    client, headers = navigation_account
    db = client.app.state.store
    identity = client.get("/auth/me", headers=headers).json()["userId"]
    actor = asyncio.run(db.get_user(identity))
    payload = configuration(client, headers)
    with pytest.raises(MenuVersionConflict):
        asyncio.run(
            db.save_navigation(version=999, items=payload["items"], actor=actor)
        )
    assert configuration(client, headers) == payload
