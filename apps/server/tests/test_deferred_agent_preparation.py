"""Web preference defers the auth side effect; execution authorization remains."""

from urllib.parse import parse_qs, urlparse

import pytest
from test_auth import admin_token, bearer, make_client, pkce_challenge
from test_identity_security import member, sign_in

from agent_server.core.server_agent import ServerAgentView
from agent_server.services.server_agent import ServerAgents

DEFERRED = {"X-SuperDsh-Agent-Preparation": "deferred"}


@pytest.fixture
def auth_client(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_SERVER_DB_URL", raising=False)
    monkeypatch.delenv("AGENT_SERVER_REDIS_URL", raising=False)
    client = make_client(tmp_path)
    observed = []
    monkeypatch.setattr(client.app.state.server_agent_login, "ensure", observed.append)
    return client, observed


@pytest.mark.parametrize("preference", [None, "deferred", "unknown"])
@pytest.mark.parametrize("client_type", ["web", "native"])
def test_auth_register_login_me_refresh_obey_only_explicit_deferred(
    auth_client, preference, client_type
):
    client, observed = auth_client
    if preference:
        client.headers["X-SuperDsh-Agent-Preparation"] = preference
    admin_token(client)
    count = 0 if preference == "deferred" else 1
    assert len(observed) == count
    response = client.post(
        "/auth/login",
        json={"identifier": "user1", "password": "secret", "clientType": client_type},
    )
    assert response.status_code == 200, response.text
    assert len(observed) == count * 2
    assert (
        client.get(
            "/auth/me", headers=bearer(response.json()["accessToken"])
        ).status_code
        == 200
    )
    assert len(observed) == count * 3
    refreshed = client.post(
        "/auth/refresh",
        json={"refreshToken": response.json()["refreshToken"]}
        if client_type == "native"
        else {},
    )
    assert refreshed.status_code == 200, refreshed.text
    assert len(observed) == count * 4
    client.headers.pop("X-SuperDsh-Agent-Preparation", None)
    assert (
        client.get(
            "/auth/me", headers=bearer(refreshed.json()["accessToken"])
        ).status_code
        == 200
    )
    assert len(observed) == count * 4 + 1


@pytest.mark.parametrize("deferred", [True, False])
def test_oauth_token_preparation_uses_the_same_preference(auth_client, deferred):
    client, observed = auth_client
    token = admin_token(client)
    observed.clear()
    verifier = "console-test-verifier"
    auth = client.get(
        "/oauth/authorize",
        headers=bearer(token),
        params={
            "response_type": "code",
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "agents-anywhere://oauth/callback",
            "code_challenge": pkce_challenge(verifier),
            "code_challenge_method": "S256",
            "scope": "profile",
            "state": "console",
        },
        follow_redirects=False,
    )
    assert auth.status_code in (302, 307), auth.text
    code = parse_qs(urlparse(auth.headers["location"]).query)["code"][0]
    result = client.post(
        "/oauth/token",
        headers=DEFERRED if deferred else {},
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": "agents-anywhere-mobile",
            "redirect_uri": "agents-anywhere://oauth/callback",
            "code_verifier": verifier,
        },
    )
    assert result.status_code == 200, result.text
    assert len(observed) == (0 if deferred else 1)


def test_deferred_does_not_prevent_explicit_authorized_prepare(
    auth_client, monkeypatch
):
    client, observed = auth_client
    client.headers.update(DEFERRED)
    token = admin_token(client)
    prepared = []

    async def prepare(_self, owner_id):
        prepared.append(owner_id)
        return ServerAgentView(status="starting")

    monkeypatch.setattr(ServerAgents, "prepare", prepare)
    result = client.post("/api/v2/server-agent", headers=bearer(token))
    assert result.status_code == 202, result.text
    assert len(prepared) == 1 and observed == []
    assert client.post("/api/v2/server-agent").status_code == 401
    role = client.post(
        "/admin/roles",
        headers=bearer(token),
        json={
            "name": "Account viewer",
            "permissions": ["devices.read"],
        },
    ).json()["id"]
    member(client, token, roles=[role])
    limited = sign_in(client)
    assert (
        client.post(
            "/api/v2/server-agent", headers=bearer(limited["accessToken"])
        ).status_code
        == 403
    )
    assert len(prepared) == 1
