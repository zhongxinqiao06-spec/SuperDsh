"""真实 PostgreSQL 与 Android 项目请求，覆盖路径身份及受管项目保护。"""

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.conversations.entity.do.models import SessionRow
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.devices.service.device_service import DeviceService


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_android_project_and_managed_workspace_boundaries(
    platform: tuple[FastAPI, AsyncClient], prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """false必须持久化；Linux大小写不合并、Windows等价路径复用，受管目录不可改建。"""
    app, client = platform
    account = await bootstrap(client, prefix)
    owner = str(account["userId"])
    devices: DeviceService = app.state.services.devices
    conversations: ConversationService = app.state.services.conversations
    linux = (
        await client.post(prefix + "/connectors", json={"name": "Linux", "deviceOs": "linux"})
    ).json()["connector"]["id"]
    windows = (
        await client.post(prefix + "/connectors", json={"name": "Windows", "deviceOs": "windows"})
    ).json()["connector"]["id"]

    async def create(connector: str, path: str, manual: bool = False) -> dict[str, object]:
        response = await client.post(
            prefix + "/projects",
            json={
                "connectorId": connector,
                "name": "移动端项目",
                "workspacePath": path,
                "manuallyCreated": manual,
            },
        )
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["attachedSessions"] == 0 and result["serverTime"]
        return result["project"]

    first = await create(linux, "/Work/Project")
    assert first["manuallyCreated"] is False
    assert (await create(linux, "/Work/./Project/", True))["id"] == first["id"]
    assert (await create(linux, "/work/project"))["id"] != first["id"]
    win = await create(windows, "C:\\Work\\Project\\")
    assert (await create(windows, "c:/work/Other/../project"))["id"] == win["id"]
    native_connector, native_project = devices.native_ids(owner)
    runtime = app.state.services.runtime
    prepare = AsyncMock(return_value={"status": "stopped"})
    monkeypatch.setattr(runtime.runner, "prepare", prepare)
    # 这里真实验证平台装配与PG事实，Host进程替身不计为真实DSH运行覆盖。
    assert (await client.get(prefix + "/server-agent")).status_code == 200
    async with conversations.repository.transaction() as dao:
        assert await dao.project(native_project) is None
    assert (await client.post(prefix + "/server-agent")).status_code == 200
    now = datetime.now(UTC)
    managed_path = str(devices.workspace(owner))
    async with conversations.repository.transaction() as dao:
        native = await dao.project(native_project)
        assert native is not None
        original_time = native.updated_at
        native.name = "保留受管项目名称"
        await dao.save(native)
        await dao.save(
            SessionRow(
                id="project-detach-synthetic",
                owner_id=owner,
                connector_id=linux,
                project_id=str(first["id"]),
                runtime_id="controlled",
                runtime_type="controlled",
                title="待解除项目关联",
                cwd="/Work/Project",
                state={},
                source={},
                status="idle",
                sequence=0,
                last_read_seq=0,
                latest_turn_end_seq=0,
                archived=False,
                pinned=False,
                takeover=False,
                created_at=now,
                updated_at=now,
            )
        )
    assert (await client.post(prefix + "/server-agent")).status_code == 200
    async with conversations.repository.transaction() as dao:
        native = await dao.project(native_project)
        assert native is not None and native.name == "保留受管项目名称"
        assert native.updated_at == original_time
    managed = await create(native_connector, managed_path, True)
    assert managed["id"] == native_project and managed["manuallyCreated"] is False
    rejected = await client.post(
        prefix + "/projects",
        json={
            "connectorId": native_connector,
            "name": "越界",
            "workspacePath": managed_path + "/child",
            "manuallyCreated": False,
        },
    )
    assert rejected.status_code == 403
    assert rejected.json()["detail"] == "server Agent workspace is managed by the platform"
    assert (await client.delete(prefix + "/projects/" + native_project)).status_code == 409
    deleted = await client.delete(prefix + "/projects/" + str(first["id"]))
    assert deleted.status_code == 200 and deleted.json()["projectId"] == first["id"]
    assert deleted.json()["detachedSessions"] == 1
    async with conversations.repository.transaction() as dao:
        row = await dao.session("project-detach-synthetic")
        assert row is not None and row.project_id is None
    assert (await client.delete(prefix + "/connectors/" + windows)).status_code == 204
    listing = (await client.get(prefix + "/projects")).json()
    assert listing["serverTime"]
    assert all(project["connectorId"] != windows for project in listing["projects"])
