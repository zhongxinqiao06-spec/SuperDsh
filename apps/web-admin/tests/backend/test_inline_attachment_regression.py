"""Android原始内联附件完整请求经双入口、真实文件库与受控RPC验证。"""

import base64
import hashlib
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.devices.entity.do.models import DeviceRuntimeRow
from app.modules.devices.service.device_service import DeviceService
from app.modules.files.service.file_service import FileService


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_android_inline_creation_download_and_receipt_idempotency(
    platform: tuple[FastAPI, AsyncClient], prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """未知本地hash可首次上传，重复请求不重复文件/RPC，不同会话同hash独立绑定。"""
    app, client = platform
    login = await bootstrap(client, prefix)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    devices: DeviceService = app.state.services.devices
    files: FileService = app.state.services.files
    registered = (
        await client.post(prefix + "/connectors", json={"name": "受控Android目标"})
    ).json()
    connector = registered["connector"]["id"]
    project = (
        await client.post(
            prefix + "/projects",
            json={
                "connectorId": connector,
                "name": "内联附件项目",
                "workspacePath": "/synthetic/inline",
            },
        )
    ).json()["project"]["id"]
    async with devices.repository.transaction() as dao:
        await dao.save(
            DeviceRuntimeRow(
                connector_id=connector,
                runtime_id="dsh",
                runtime_type="dsh",
                name="合成DSH",
                configuration={},
                active=True,
                status="running",
                revision=1,
                metadata_json={},
                updated_at=datetime.now(UTC),
            )
        )
    original_view = devices.view
    monkeypatch.setattr(devices, "view", lambda row: {**original_view(row), "status": "online"})
    call = AsyncMock(return_value={"accepted": True, "externalSessionId": "synthetic-external"})
    monkeypatch.setattr(devices, "call", call)
    data = "Android 内联附件，不调用外部模型。".encode()
    digest = hashlib.sha256(data).hexdigest()
    attachment = {
        "fileId": digest,
        "name": "android.txt",
        "mediaType": "text/plain",
        "size": len(data),
        "sha256": digest,
        "contentBase64": base64.b64encode(data).decode(),
    }
    body = {
        "connectorId": connector,
        "projectId": project,
        "runtime": "dsh",
        "content": "查看合成附件",
        "clientMessageId": "android-inline",
        "attachments": [attachment],
    }
    first = await client.post(prefix + "/sessions/create-and-start", json=body)
    assert first.status_code == 200, first.text
    session_id = first.json()["session"]["id"]
    assert call.await_count == 1
    forwarded = call.call_args.args[3]
    assert forwarded["attachments"] == forwarded["timelineAttachments"]
    item = forwarded["attachments"][0]
    assert item["fileId"] == digest and "contentBase64" not in item
    assert item["sha256"] == digest and item["size"] == len(data)
    retry = await client.post(prefix + "/sessions/create-and-start", json=body)
    assert retry.status_code == 200 and retry.json()["session"]["id"] == session_id
    assert call.await_count == 1
    downloaded = await client.get(prefix + f"/sessions/{session_id}/attachments/{digest}")
    assert downloaded.status_code == 200, downloaded.text
    assert base64.b64decode(downloaded.json()["contentBase64"]) == data
    assert downloaded.json()["fileId"] == digest
    async with files.repository.transaction() as dao:
        rows = await dao.bound_entries(account.user_id, "session", session_id)
        assert len(rows) == 1 and rows[0].sha256 == digest
    second = await client.post(
        prefix + "/sessions/create-and-start", json={**body, "clientMessageId": "another-session"}
    )
    assert second.status_code == 200 and call.await_count == 2
    second_id = second.json()["session"]["id"]
    async with files.repository.transaction() as dao:
        other = await dao.bound_entries(account.user_id, "session", second_id)
        assert len(other) == 1 and other[0].id != rows[0].id
    # 对已接受的会话重复绑定同alias同内容，不增加对象；别名内容冲突明确拒绝。
    staged = await files.stage_session(account, session_id, [attachment])
    assert staged[0][0] == digest and staged[0][1] == data
    corrupted = {
        **attachment,
        "contentBase64": base64.b64encode(b"different").decode(),
        "size": 9,
        "sha256": hashlib.sha256(b"different").hexdigest(),
    }
    from app.infrastructure.errors import DomainError

    with pytest.raises(DomainError, match="历史文件标识不可覆盖"):
        await files.stage_session(account, session_id, [corrupted])
    invalid = await client.post(
        prefix + "/sessions/create-and-start",
        json={
            **body,
            "clientMessageId": "invalid-inline",
            "attachments": [{**attachment, "sha256": "0" * 64}],
        },
    )
    assert (
        invalid.status_code == 422
        and invalid.json()["detail"] == "attachment sha256 does not match content"
    )
    assert call.await_count == 2
    # Connector读取使用原别名且仍校验设备与会话归属。
    token_response = await client.post(
        prefix + "/connector/auth",
        headers={"Authorization": f"Connector {connector}:{registered['connectorToken']}"},
    )
    assert token_response.status_code == 200, token_response.text
    content = await client.get(
        prefix + f"/connector/sessions/{session_id}/attachments/{digest}/content",
        headers={"Authorization": "Bearer " + token_response.json()["accessToken"]},
    )
    assert content.status_code == 200 and content.content == data
