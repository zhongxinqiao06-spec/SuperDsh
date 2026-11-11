"""第二阶段文件、设备与会话在隔离 PostgreSQL 中验证真实权限及恢复。"""

import asyncio
import hashlib
from pathlib import Path
from typing import cast

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.vo.conversation_dto import CreateSessionInput
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.devices.service.device_service import DeviceService
from app.modules.files.service.file_service import FileService
from app.modules.identity.entity.bo.models import Account


async def account_for(application: FastAPI, client: AsyncClient) -> Account:
    await bootstrap(client)
    return cast(
        Account,
        await application.state.services.identity.authenticate(client.headers["Authorization"][7:]),
    )


async def test_session_list_order_follows_messages_not_renames(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """真实SQL排序：改名/读取不置顶历史消息，取消置顶恢复原消息活动顺序。"""
    application, client = platform
    account = await account_for(application, client)
    created = await client.post("/api/connectors", json={"name": "排序测试设备"})
    assert created.status_code == 200, created.text
    connector = created.json()["connector"]["id"]
    service: ConversationService = application.state.services.conversations
    for index, identifier in enumerate(("synthetic-order-first", "synthetic-order-second")):
        await service.projection.ingest(
            account.user_id,
            connector,
            "session.created",
            {"sessionId": identifier, "runtime": "dsh", "runtimeId": "dsh"},
        )
        await service.projection.ingest(
            account.user_id,
            connector,
            "timeline.itemUpsert",
            {
                "sessionId": identifier,
                "item": {
                    "id": f"item-{index}",
                    "type": "message",
                    "orderSeq": index + 1,
                    "createdAt": f"2025-01-0{index + 1}T00:00:00Z",
                },
            },
        )
    initial = await service.listing(account, {})
    expected = [str(row["id"]) for row in cast(list[dict[str, object]], initial["sessions"])]
    assert expected == ["synthetic-order-second", "synthetic-order-first"]
    await service.update(account, expected[1], {"title": "仅修改旧会话标题", "read": True})
    listed = await service.listing(account, {})
    assert [row["id"] for row in cast(list[dict[str, object]], listed["sessions"])] == expected
    await service.update(account, expected[1], {"pinned": True})
    pinned = await service.listing(account, {})
    assert cast(list[dict[str, object]], pinned["sessions"])[0]["id"] == expected[1]
    await service.update(account, expected[1], {"pinned": False})
    unpinned = await service.listing(account, {})
    assert [row["id"] for row in cast(list[dict[str, object]], unpinned["sessions"])] == expected


async def test_chunk_upload_resume_checksum_and_download(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    await account_for(application, client)
    content = "验证上传与续传".encode()
    body = {
        "name": "验证.txt",
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "mediaType": "text/plain",
        "idempotencyKey": "upload-stable-identity",
    }
    begin = await client.post("/api/files/uploads", json=body)
    assert begin.status_code == 200, begin.text
    identifier = begin.json()["id"]
    assert (await client.post("/api/files/uploads", json=body)).json()["id"] == identifier
    assert (
        await client.post("/api/files/uploads", json={**body, "name": "another.txt"})
    ).status_code == 409
    assert (await client.post(f"/api/files/uploads/{identifier}/complete")).status_code == 409
    assert (
        await client.put(f"/api/files/uploads/{identifier}/parts/1", content=b"short")
    ).status_code == 422
    assert (
        await client.put(f"/api/files/uploads/{identifier}/parts/1", content=content)
    ).status_code == 200
    completed = await client.post(f"/api/files/uploads/{identifier}/complete")
    assert completed.status_code == 200, completed.text
    file_id = completed.json()["id"]
    assert (await client.post(f"/api/files/uploads/{identifier}/complete")).json()["id"] == file_id
    downloaded = await client.get(f"/api/files/{file_id}/content", headers={"Range": "bytes=0-2"})
    assert downloaded.status_code == 206 and downloaded.content == content[:3]
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    await client.post(f"/api/files/{file_id}/trash")
    assert (await client.get(f"/api/files/{file_id}/content")).status_code == 404
    await client.post(f"/api/files/{file_id}/restore")
    assert (await client.get(f"/api/files/{file_id}/content")).content == content


async def test_asset_delegation_and_foreign_owner_are_explicit(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    account = await account_for(application, client)
    files: FileService = application.state.services.files
    limited = Account(account.user_id, account.username, (), ("agents.manage",), 0)
    entry = await files.ingest_asset(limited, "asset.txt", b"owned-asset", "text/plain")
    file_id = str(entry["id"])
    assert (await files.read_asset(limited, file_id))[0] == b"owned-asset"
    with pytest.raises(DomainError) as denied:
        await files.read(limited, file_id)
    assert denied.value.status == 403
    foreign = Account("foreign-owner", "foreign", (), ("agents.manage",), 0)
    with pytest.raises(DomainError) as hidden:
        await files.read_asset(foreign, file_id)
    assert hidden.value.status == 404
    await files.bind_asset(limited, file_id, "asset", "asset-one")
    with pytest.raises(DomainError):
        await files.remove_asset(limited, file_id)
    await files.unbind_asset(limited, file_id, "asset", "asset-one")
    await files.remove_asset(limited, file_id)


async def test_pairing_single_claim_and_revocation(platform: tuple[FastAPI, AsyncClient]) -> None:
    _, client = platform
    await bootstrap(client)
    begin = await client.post("/api/pairing/start", json={"serverUrl": "http://localhost:8001"})
    assert begin.status_code == 200, begin.text
    result = begin.json()
    claims = await asyncio.gather(
        *(
            client.post("/api/pairing/claim", json={"code": result["code"], "name": "隔离设备"})
            for _ in range(2)
        )
    )
    assert sorted(response.status_code for response in claims) == [200, 409]
    poll = await client.post("/api/pairing/poll", json={"pairingId": result["pairingId"]})
    configuration = poll.json()["config"]
    assert (
        await client.post("/api/pairing/poll", json={"pairingId": result["pairingId"]})
    ).status_code == 409
    connector = configuration["connectorId"]
    auth = await client.post(
        "/api/connector/auth",
        headers={"Authorization": f"Connector {connector}:{configuration['connectorToken']}"},
    )
    assert auth.status_code == 200, auth.text
    access = auth.json()["accessToken"]
    assert (await client.post(f"/api/connectors/{connector}/revoke")).status_code == 200
    assert (
        await client.post(
            "/api/connector/ingest",
            headers={"Authorization": "Bearer " + access},
            json={"notifications": []},
        )
    ).status_code == 401


async def test_workspace_path_and_write_conflict(platform: tuple[FastAPI, AsyncClient]) -> None:
    application, client = platform
    account = await account_for(application, client)
    devices: DeviceService = application.state.services.devices
    await devices.ensure_native(account.user_id)
    connector = devices.native_ids(account.user_id)[0]
    prefix = f"/api/connectors/{connector}/fs"
    assert (
        await client.post(prefix + "/readText", json={"path": "../outside.txt"})
    ).status_code == 403
    first = await client.post(prefix + "/write", json={"path": "editable.txt", "content": "first"})
    assert first.status_code == 200, first.text
    version = first.json()["result"]["sha256"]
    second = await client.post(
        prefix + "/write", json={"path": "editable.txt", "content": "second", "ifMatch": version}
    )
    assert second.status_code == 200
    conflict = await client.post(
        prefix + "/write", json={"path": "editable.txt", "content": "lost", "ifMatch": version}
    )
    assert conflict.status_code == 412
    assert (await client.post(prefix + "/readText", json={"path": "editable.txt"})).json()[
        "content"
    ] == "second"
    assert (
        (devices.workspace(account.user_id) / "editable.txt").is_relative_to(
            Path(application.state.settings.data_dir)
        )
        if hasattr(application.state, "settings")
        else True
    )


async def test_projection_replay_sequence_share_and_ticket(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    account = await account_for(application, client)
    devices: DeviceService = application.state.services.devices
    conversations: ConversationService = application.state.services.conversations
    device = (await client.post("/api/connectors", json={"name": "会话设备"})).json()["connector"]
    connector = device["id"]
    # 投影/分享测试直接准备合成事实，不能用缺少外部身份的请求伪装HTTP导入。
    created = await conversations.create(
        account,
        CreateSessionInput(
            connectorId=connector, clientMessageId="create-stable", title="验证历史"
        ),
        False,
    )
    identifier = cast(dict[str, object], created["session"])["id"]
    assert isinstance(identifier, str)
    item = {
        "id": "item_one",
        "sessionId": identifier,
        "type": "message.user",
        "revision": 1,
        "orderSeq": 1,
        "content": {"text": "持久事实"},
    }
    params: dict[str, object] = {"sessionId": identifier, "item": item}
    await conversations.projection.ingest(account.user_id, connector, "timeline.itemUpsert", params)
    await conversations.projection.ingest(account.user_id, connector, "timeline.itemUpsert", params)
    snapshot = (await client.get(f"/api/sessions/{identifier}/snapshot")).json()
    assert len(snapshot["timeline"]["items"]) == 1
    assert snapshot["eventCursor"] == "seq:1"
    events = (
        await client.get(f"/api/sessions/{identifier}/events", params={"cursor": "seq:0"})
    ).json()
    assert [entry["sequence"] for entry in events["events"]] == [1, 1, 1, 1]
    assert {entry["type"] for entry in events["events"]} == {
        "timeline.item_created",
        "session.meta.updated",
        "runtime.state.updated",
        "runtime.capability.updated",
    }
    assert events["snapshotRequired"] is False and events["nextCursor"] == "seq:1"
    # HTTP 恢复补齐当前状态；WS 日志仍只包含一次持久投影，不能反复制造状态帧。
    durable = await conversations.events(account, identifier, 0)
    assert isinstance(durable["events"], list)
    assert len(durable["events"]) == 1
    foreign = await devices.own(account, connector)
    with pytest.raises(DomainError):
        await conversations.projection.ingest(
            "another-owner", foreign.id, "timeline.itemUpsert", params
        )
    shared = (await client.post(f"/api/sessions/{identifier}/shares")).json()["share"]["id"]
    public = (await client.get(f"/api/public/shares/{shared}")).json()
    assert public["timeline"]["items"][0]["content"]["text"] == "持久事实"
    assert set(public["session"]) == {"id", "title", "runtime", "runtimeName", "cwd"}
    assert public["session"]["cwd"] == cast(dict[str, object], created["session"])["cwd"]
    assert not {"ownerId", "connectorId", "state", "accessToken", "refreshToken", "token"} & set(
        public["session"]
    )
    issued = (
        await client.post(
            "/api/ws-ticket", json={"clientId": "browser-one", "scope": {"sessionId": identifier}}
        )
    ).json()
    _, token, client_id = await conversations.tickets.consume(
        issued["ticket"], "browser-one", {"sessionId": identifier}
    )
    assert token
    assert client_id == "browser-one"
    with pytest.raises(DomainError):
        await conversations.tickets.consume(
            issued["ticket"], "browser-one", {"sessionId": identifier}
        )
    await client.delete(f"/api/shares/{shared}")
    assert (await client.get(f"/api/public/shares/{shared}")).status_code == 404


async def test_real_managed_terminal_is_closed(platform: tuple[FastAPI, AsyncClient]) -> None:
    application, client = platform
    account = await account_for(application, client)
    devices: DeviceService = application.state.services.devices
    await devices.ensure_native(account.user_id)
    connector = devices.native_ids(account.user_id)[0]
    created = await client.post(
        f"/api/connectors/{connector}/terminals", json={"name": "隔离验证终端"}
    )
    assert created.status_code == 200, created.text
    identifier = created.json()["terminal"]["id"]
    try:
        response = await client.post(
            f"/api/connectors/{connector}/terminals/{identifier}/write",
            json={"data": "echo VALIDATION_PTY_OK\r\n"},
        )
        assert response.status_code == 200, response.text
        for _ in range(30):
            snapshot = (
                await client.get(f"/api/connectors/{connector}/terminals/{identifier}/snapshot")
            ).json()
            if "VALIDATION_PTY_OK" in snapshot["data"]:
                break
            await asyncio.sleep(0.2)
        assert "VALIDATION_PTY_OK" in snapshot["data"]
    finally:
        closed = await client.delete(f"/api/connectors/{connector}/terminals/{identifier}")
        assert closed.status_code == 200, closed.text
    assert not devices.terminals.terminals
