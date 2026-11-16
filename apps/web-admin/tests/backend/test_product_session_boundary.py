"""真实登录、产品撤权和作品绑定贯穿 HTTP、订阅票据与原生诊断；引擎应答使用隔离替身。"""

from unittest.mock import AsyncMock

import pytest
from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient
from pytest import MonkeyPatch

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.vo.conversation_dto import CreateSessionInput
from app.modules.conversations.service.subscription_service import SubscriptionService


async def test_mixed_roles_cannot_cross_session_product_after_revocation(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: MonkeyPatch
) -> None:
    app, client = platform
    services = app.state.services
    await bootstrap(client)
    username, password = "studio-member", "Synthetic-mixed-123!"
    response = await client.post(
        "/api/admin/users",
        json={
            "username": username,
            "displayName": "双产品合成账号",
            "password": password,
            "roles": ["office_admin", "entertainment_creator"],
        },
    )
    assert response.status_code == 201, response.text
    login = await complete_initial_login(client, username, password)
    uid = str(login["userId"])
    auth = {"Authorization": "Bearer " + str(login["accessToken"])}
    account = await services.identity.authenticate(login["accessToken"])
    conversations = services.conversations
    project = (
        await client.post("/api/studio/projects", json={"title": "短片"}, headers=auth)
    ).json()["id"]
    path = f"/api/studio/projects/{project}/conversation"
    response = await client.post(path, headers=auth)
    assert response.status_code == 200, response.text
    studio = response.json()["sessionId"]
    connector, workspace = conversations.devices.native_ids(uid)
    office = (
        await conversations.create(
            account,
            CreateSessionInput(
                connectorId=connector,
                projectId=workspace,
                title="办公历史",
                clientMessageId="isolated-office",
            ),
            start=False,
        )
    )["session"]["id"]
    async with conversations.repository.transaction() as dao:
        historical = await dao.session(office)
        historical.source = {
            key: value for key, value in historical.source.items() if key != "product"
        }
        await dao.save(historical)

    # 办公看板、项目统计只计办公活动。与旧数据相同，无产品标签的会话仍可打开。
    response = await client.get("/api/projects", headers=auth)
    assert response.json()["projects"][0]["activeSessionCount"] == 1
    snapshot = await SubscriptionService(conversations).dashboard(account)
    snapshot_rows = snapshot["sessions"]
    assert isinstance(snapshot_rows, list)
    assert [row["id"] for row in snapshot_rows] == [office]
    scope = {"clientId": "rbac", "scope": {"sessionId": studio}}
    prior_ticket = (await client.post("/api/ws-ticket", headers=auth, json=scope)).json()["ticket"]
    runtime = services.runtime
    message = {"clientMessageId": "first", "content": "写分镜"}
    engine = AsyncMock(return_value={"ok": True, "externalSessionId": "director-native-id"})
    monkeypatch.setattr(runtime.runner, "call", engine)
    running = False

    async def start(owner: str) -> dict:
        nonlocal running
        assert owner == uid
        running = True
        return {"status": "running"}

    monkeypatch.setattr(
        runtime.runner, "status", lambda owner: {"status": "running" if running else "stopped"}
    )
    monkeypatch.setattr(runtime.runner, "prepare", start)
    # 保留智能体的真实冻结、工具选择和收据，用替身截住 DSH 进程边界。
    monkeypatch.setattr(runtime.runner, "install_tool", AsyncMock())
    monkeypatch.setattr(runtime.runner, "install_preset", AsyncMock())

    async def change_roles(roles: list[str]) -> dict[str, str]:
        edited = await client.patch("/api/admin/users/" + uid, json={"roles": roles})
        assert edited.status_code == 200, edited.text
        res = await client.post(
            "/api/auth/login",
            json={"identifier": username, "password": password, "clientType": "native"},
        )
        assert res.status_code == 200, res.text
        return {"Authorization": "Bearer " + res.json()["accessToken"]}

    auth = await change_roles(["entertainment_creator"])
    for method, url, body in [
        ("GET", "/api/sessions", None),
        ("GET", "/api/sessions/list", None),
        ("GET", f"/api/sessions/{office}/meta", None),
        (
            "POST",
            "/api/sessions/create-and-start",
            {"connectorId": connector, "projectId": workspace, **message},
        ),
        ("GET", "/api/projects", None),
        ("GET", "/api/runtime/events", None),
        ("POST", "/api/server-agent", None),
        ("GET", "/api/runtime/catalogs/models", None),
        ("GET", f"/api/runtime/sessions/{office}", None),
        ("POST", "/api/runtime/sessions", {"sessionId": "unbound", **message}),
        ("POST", f"/api/runtime/sessions/{office}/messages", {"sessionId": office, **message}),
        ("POST", f"/api/runtime/sessions/{office}/interrupt", None),
        ("POST", "/api/ws-ticket", {**scope, "scope": {"dashboard": True}}),
        ("POST", "/api/ws-ticket", {**scope, "scope": {"sessionId": office}}),
    ]:
        res = await client.request(method, url, headers=auth, json=body)
        assert res.status_code == 403, (url, res.text)
    engine.assert_not_awaited()
    assert (await client.post(path, headers=auth)).json()["sessionId"] == studio
    # 无设备管理权也能为本人已绑定的作品从冷启动准备；不能操作其他账号的工程。
    outsider = await client.post(path + "/runtime")
    assert outsider.status_code == 404
    ready = await client.post(path + "/runtime", headers=auth)
    assert ready.status_code == 200, ready.text
    assert (await client.get(path + "/runtime", headers=auth)).json()["agent"][
        "status"
    ] == "running"
    assert (await client.post("/api/ws-ticket", headers=auth, json=scope)).status_code == 200
    assert [
        r["id"]
        for r in (await client.get("/api/sessions?product=entertainment", headers=auth)).json()[
            "sessions"
        ]
    ] == [studio]
    res = await client.post(f"/api/sessions/{studio}/runtime/messages", headers=auth, json=message)
    assert res.status_code == 200, res.text
    first = engine.await_args
    assert first and first.args[1] == "session.createAndStart"
    assert first.args[2]["sessionId"] == studio
    assert first.args[2]["_starbridgeProduct"] == "entertainment"
    assert (
        await client.post(f"/api/sessions/{studio}/runtime/messages", headers=auth, json=message)
    ).status_code == 200
    engine.assert_awaited_once()
    await conversations.projection.ingest(
        uid, connector, "session.state.updated", {"sessionId": studio, "status": "idle"}
    )
    engine.side_effect = [
        {"status": "idle", "sessionId": studio},
        {
            "capabilities": [
                {
                    "capabilityId": "session.send_message",
                    "supported": True,
                    "available": True,
                    "allowed": True,
                }
            ]
        },
        {"ok": True},
    ]
    continued = await client.post(
        f"/api/sessions/{studio}/runtime/messages",
        headers=auth,
        json={"clientMessageId": "second", "content": "继续完善分镜"},
    )
    assert continued.status_code == 200, continued.text
    second = engine.await_args
    assert second and second.args[1] == "session.startTurn"

    auth = await change_roles(["office_admin"])
    assert (await client.get(f"/api/sessions/{office}/meta", headers=auth)).status_code == 200
    for session_id in (studio, "director-native-id"):
        assert (
            await client.get("/api/runtime/sessions/" + session_id, headers=auth)
        ).status_code == 403
        data = {"externalSessionId": session_id, "connectorId": connector, "projectId": workspace}
        assert (await client.post("/api/sessions", headers=auth, json=data)).status_code == 403
    assert (await client.post(path, headers=auth)).status_code == 403
    assert (await client.post(path + "/runtime", headers=auth)).status_code == 403
    assert (await client.get(f"/api/sessions/{studio}/meta", headers=auth)).status_code == 403
    assert (await client.post("/api/ws-ticket", headers=auth, json=scope)).status_code == 403
    with pytest.raises(DomainError) as revoked:
        await conversations.tickets.consume(prior_ticket, "rbac", scope["scope"])
    assert revoked.value.status == 401
    notifications = [
        {"method": "session.upsert", "params": {"sessionId": sid, "title": title}}
        for sid, title in [(studio, "私有短片"), (office, "可见办公")]
    ]
    batches = [
        {
            "cursor": 3,
            "batch": {
                "operations": [
                    {"kind": "notifications", "notifications": notifications},
                    {"kind": "checkpoint.load", "externalSessionId": "director-native-id"},
                    {"kind": "snapshot.begin", "sessionId": studio},
                    {"kind": "workspace.inventory", "private": studio},
                ]
            },
        }
    ]
    monkeypatch.setattr(runtime.runner, "events", AsyncMock(return_value=batches))
    feed = (await client.get("/api/runtime/events", headers=auth)).json()["events"]
    assert feed == [
        {
            "cursor": 3,
            "batch": {
                "operations": [{"kind": "notifications", "notifications": [notifications[1]]}]
            },
        }
    ]
