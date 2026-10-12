"""HTTP and live ASGI WebSocket revocation using private SQLite and file roots."""

import asyncio
from urllib.parse import parse_qs, urlparse

import anyio
import pytest
from starlette.websockets import WebSocketDisconnect
from test_auth import admin_token, bearer, make_client, pkce_challenge
from test_backend_mvp import (
    create_connector_and_session,
    dashboard_ws_ticket,
    ws_ticket,
)
from test_identity_security import member, sign_in

from agent_server.core.auth import create_signed_token, user_access_claims


async def _receive(ws):
    with anyio.fail_after(5):
        return await ws._send_rx.receive()


def receive(ws):
    return ws.portal.call(_receive, ws)


@pytest.mark.parametrize("change", ["disable", "roles", "logout"])
def test_idle_dashboard_socket_closes_after_shared_store_revocation(tmp_path, change):
    client = make_client(tmp_path)
    admin = admin_token(client)
    role_id = None
    if change == "roles":
        created = client.post(
            "/admin/roles",
            headers=bearer(admin),
            json={
                "name": "Session observer",
                "permissions": ["devices.read", "sessions.read"],
            },
        )
        assert created.status_code == 201, created.text
        role_id = created.json()["id"]
    user = member(client, admin, roles=[role_id] if role_id else None)
    login = sign_in(client)
    headers = bearer(login["accessToken"])
    ticket = dashboard_ws_ticket(client, headers)
    with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
        assert receive(ws)["type"] == "websocket.send"
        if change == "logout":
            sid = user_access_claims(login["accessToken"])["sid"]
            assert (
                client.delete(f"/auth/sessions/{sid}", headers=headers).status_code
                == 204
            )
        elif change == "disable":
            assert (
                client.patch(
                    f"/admin/users/{user['userId']}",
                    headers=bearer(admin),
                    json={"disabled": True},
                ).status_code
                == 200
            )
        else:
            assert (
                client.patch(
                    f"/admin/roles/{role_id}",
                    headers=bearer(admin),
                    json={"name": "Session observer", "permissions": ["devices.read"]},
                ).status_code
                == 200
            )
        assert receive(ws) == {
            "type": "websocket.close",
            "code": 4403,
            "reason": "authorization changed",
        }


def test_unused_ticket_cannot_be_revived_by_new_login_header_or_query(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    member(client, admin)
    first = sign_in(client)
    ticket = dashboard_ws_ticket(client, bearer(first["accessToken"]))
    assert (
        client.post(
            "/auth/logout", json={"refreshToken": first["refreshToken"]}
        ).status_code
        == 204
    )
    second = sign_in(client)
    with (
        pytest.raises(WebSocketDisconnect) as error,
        client.websocket_connect(
            f"/dashboard/ws?ticket={ticket}&token={second['accessToken']}",
            headers=bearer(second["accessToken"]),
        ),
    ):
        pass
    assert error.value.code == 4403


def test_unused_oauth_code_is_revoked_with_issuing_login(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    verifier = "revoked-grant-verifier"
    granted = client.post(
        "/oauth/authorize",
        headers=bearer(token),
        json={
            "response_type": "code",
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "agents-anywhere://oauth/callback",
            "code_challenge": pkce_challenge(verifier),
            "code_challenge_method": "S256",
        },
    )
    assert granted.status_code == 200, granted.text
    code = parse_qs(urlparse(granted.json()["redirectUrl"]).query)["code"][0]
    sid = user_access_claims(token)["sid"]
    assert (
        client.delete(f"/auth/sessions/{sid}", headers=bearer(token)).status_code == 204
    )
    exchange = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "agents-anywhere://oauth/callback",
            "code_verifier": verifier,
        },
    )
    assert exchange.status_code == 400, exchange.text
    assert exchange.json()["detail"] == "authorization grant expired or revoked"


def test_approved_mobile_qr_cannot_create_session_after_browser_logout(tmp_path):
    client = make_client(tmp_path)
    token = admin_token(client)
    grant = client.post("/auth/mobile-login/qr", headers=bearer(token)).json()
    payload = {"userId": grant["userId"], "loginToken": grant["loginToken"]}
    assert (
        client.post(
            "/auth/mobile-login/request", json={**payload, "deviceName": "Test phone"}
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/auth/mobile-login/confirm",
            headers=bearer(token),
            json={"loginToken": grant["loginToken"], "approved": True},
        ).status_code
        == 200
    )
    sid = user_access_claims(token)["sid"]
    assert (
        client.delete(f"/auth/sessions/{sid}", headers=bearer(token)).status_code == 204
    )
    assert client.post("/auth/mobile-login/exchange", json=payload).status_code == 401
    assert (
        client.post(
            "/auth/mobile-login/request", json={**payload, "deviceName": "Test phone"}
        ).status_code
        == 401
    )


def test_session_socket_rechecks_logout_on_received_frame(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    ticket = ws_ticket(client, session_id, headers)
    sid = user_access_claims(headers["Authorization"].removeprefix("Bearer "))["sid"]
    with client.websocket_connect(f"/sessions/{session_id}/ws?ticket={ticket}") as ws:
        assert receive(ws)["type"] == "websocket.send"
        assert (
            client.delete(f"/auth/sessions/{sid}", headers=headers).status_code == 204
        )
        ws.send_json({"type": "ping"})
        assert receive(ws)["code"] == 4403


def test_anonymous_pairing_can_start_poll_but_not_claim(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    start = client.post("/pairing/start", json={"serverUrl": "https://example.test"})
    assert start.status_code == 200, start.text
    pairing = start.json()
    assert (
        client.post(
            "/pairing/poll", json={"pairingId": pairing["pairingId"]}
        ).status_code
        == 200
    )
    claim = {
        "code": pairing["code"],
        "name": "Desktop",
        "serverUrl": "https://example.test",
    }
    assert client.post("/pairing/claim", json=claim).status_code == 401
    assert (
        client.post("/pairing/claim", headers=bearer(admin), json=claim).status_code
        == 200
    )
    assert (
        client.post("/pairing/poll", json={"pairingId": pairing["pairingId"]}).json()[
            "status"
        ]
        == "claimed"
    )


def preview_token(client, headers, connector_id):
    result = client.post(
        f"/connectors/{connector_id}/fs/preview-token",
        headers=headers,
        params={"root": "/tmp/project"},
        json={"path": "README.md"},
    )
    assert result.status_code == 200, result.text
    return result.json()["previewToken"]


def test_preview_exchange_and_transfer_stay_bound_to_original_login(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    member(client, admin)
    first = sign_in(client)
    headers = bearer(first["accessToken"])
    connector_id = client.post(
        "/connectors", headers=headers, json={"name": "Laptop"}
    ).json()["connector"]["id"]
    unused = preview_token(client, headers, connector_id)
    open_token = preview_token(client, headers, connector_id)
    opened = client.post(
        "/connectors/fs/preview-session", json={"previewToken": open_token}
    )
    assert opened.status_code == 200, opened.text
    access = opened.json()["previewAccessToken"]
    # An unknown transfer returns its resource error, rather than rejecting a
    # valid scoped credential as though the opaque transfer secret were a JWT.
    download = f"/connectors/{connector_id}/fs/transfers/missing?token=opaque&previewAccessToken={access}"
    assert client.get(download).status_code == 404
    assert (
        client.post(
            "/auth/logout", json={"refreshToken": first["refreshToken"]}
        ).status_code
        == 204
    )
    fresh = bearer(sign_in(client)["accessToken"])
    for supplied in ({}, fresh, bearer(admin)):
        assert (
            client.post(
                "/connectors/fs/preview-session",
                headers=supplied,
                json={"previewToken": unused},
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/connectors/fs/preview/readText",
                headers=supplied,
                json={"previewAccessToken": access},
            ).status_code
            == 401
        )
        assert client.get(download, headers=supplied).status_code == 401
    legacy = create_signed_token(
        "fs_preview_access",
        {
            "user_id": first["userId"],
            "connector_id": connector_id,
            "root": "/tmp/project",
            "path": "/tmp/project/README.md",
        },
        300,
    )
    assert (
        client.post(
            "/connectors/fs/preview/readText",
            headers=fresh,
            json={"previewAccessToken": legacy},
        ).status_code
        == 401
    )


def test_private_attachment_link_is_revocable_even_with_fresh_bearer(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    upload = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"files": ("private.txt", b"private bytes", "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    file = upload.json()["attachments"][0]
    opened = client.get(file["openUrl"], headers=headers, follow_redirects=False)
    link = opened.headers["location"]
    assert client.get(link).content == b"private bytes"
    sid = user_access_claims(headers["Authorization"].removeprefix("Bearer "))["sid"]
    assert client.delete(f"/auth/sessions/{sid}", headers=headers).status_code == 204
    # A separate managed login must not revive a leaked URL from the old one.
    user_id = user_access_claims(headers["Authorization"].removeprefix("Bearer "))[
        "sub"
    ]
    fresh = asyncio.run(client.app.state.store.issue_login(user_id))["accessToken"]
    assert client.get(link).status_code == 401
    assert client.get(link, headers=bearer(fresh)).status_code == 401


def test_custom_settings_permission_reaches_existing_admin_routes(tmp_path):
    client = make_client(tmp_path)
    admin = admin_token(client)
    created = client.post(
        "/admin/roles",
        headers=bearer(admin),
        json={"name": "Operator", "permissions": ["settings.manage"]},
    )
    assert created.status_code == 201, created.text
    member(client, admin, roles=[created.json()["id"]])
    headers = bearer(sign_in(client)["accessToken"])
    for path in ("/admin/service", "/admin/dashboard/settings", "/admin/announcement"):
        response = client.get(path, headers=headers)
        assert response.status_code == 200, response.text
    assert client.get("/admin/users", headers=headers).status_code == 403


def test_live_connector_socket_is_closed_and_reconnect_stays_blocked(tmp_path):
    # A lifespan keeps the HTTP control request and connector tasks on the
    # same server event loop, matching a real ASGI deployment.
    with make_client(tmp_path) as client:
        connector_id, access, _, headers = create_connector_and_session(client)
        with client.websocket_connect(
            "/connector/ws",
            headers={**bearer(access), "x-connector-version": "2.3.4-test"},
        ) as ws:
            assert receive(ws)["type"] == "websocket.send"
            response = client.post(
                f"/admin/devices/{connector_id}/block",
                headers=headers,
                json={"reason": "maintenance"},
            )
            assert response.status_code == 200, response.text
            for _ in range(10):
                frame = receive(ws)
                if frame["type"] == "websocket.close":
                    break
            else:
                pytest.fail("connector did not close")
        assert (
            asyncio.run(client.app.state.store.get_connector(connector_id)).version
            == "2.3.4-test"
        )
        with (
            pytest.raises(WebSocketDisconnect),
            client.websocket_connect("/connector/ws", headers=bearer(access)),
        ):
            pass
