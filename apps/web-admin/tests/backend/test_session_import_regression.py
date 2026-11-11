"""导入会话在真实数据库验证无执行、副作用边界和跨设备幂等。"""

import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.devices.entity.do.models import DeviceRuntimeRow
from app.modules.devices.service.device_service import DeviceService


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_import_is_persist_only_and_scoped_idempotent(
    platform: tuple[FastAPI, AsyncClient], prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """原导入请求可无消息键，提供键则完整请求去重；不能伪装成首次发送。"""
    app, client = platform
    await bootstrap(client, prefix)
    devices: DeviceService = app.state.services.devices
    call = AsyncMock(side_effect=AssertionError("导入不应执行RPC"))
    monkeypatch.setattr(devices, "call", call)
    connectors, projects = [], []
    for index in range(2):
        connector = (
            await client.post(
                prefix + "/connectors", json={"name": f"导入设备{index}", "deviceOs": "linux"}
            )
        ).json()["connector"]["id"]
        project = (
            await client.post(
                prefix + "/projects",
                json={
                    "name": f"导入项目{index}",
                    "connectorId": connector,
                    "workspacePath": "/synthetic/import",
                },
            )
        ).json()["project"]["id"]
        connectors.append(connector)
        projects.append(project)
    body = {
        "connectorId": connectors[0],
        "projectId": projects[0],
        "runtime": "dsh",
        "externalSessionId": "existing-history",
        "selections": {"model": "existing-model"},
    }
    missing = await client.post(
        prefix + "/sessions",
        json={key: value for key, value in body.items() if key != "externalSessionId"},
    )
    assert missing.status_code == 422 and "externalSessionId" in missing.json()["detail"]
    unconfigured = await client.post(prefix + "/sessions", json=body)
    assert (
        unconfigured.status_code == 409
        and unconfigured.json()["detail"] == "runtime is not configured"
    )
    async with devices.repository.transaction() as dao:
        for connector in connectors:
            await dao.save(
                DeviceRuntimeRow(
                    connector_id=connector,
                    runtime_id="dsh",
                    runtime_type="dsh",
                    name="受控配置",
                    configuration={},
                    active=False,
                    status="stopped",
                    revision=1,
                    metadata_json={},
                    updated_at=datetime.now(UTC),
                )
            )
    first = await client.post(prefix + "/sessions", json=body)
    assert first.status_code == 200, first.text
    observed = first.json()
    assert observed["connectorResult"] is None
    assert observed["session"]["externalSessionId"] == body["externalSessionId"]
    assert observed["session"]["cwd"] == "/synthetic/import"
    assert observed["session"]["status"] == "idle" and observed["session"]["takeover"] is True
    repeated = await client.post(prefix + "/sessions", json=body)
    assert (
        repeated.status_code == 200
        and repeated.json()["session"]["id"] != observed["session"]["id"]
    )
    stable_body = {**body, "clientMessageId": "stable-import"}
    long_identity = await client.post(
        prefix + "/sessions", json={**body, "externalSessionId": "external-" + "x" * 300}
    )
    assert long_identity.status_code == 200, long_identity.text
    assert long_identity.json()["session"]["externalSessionId"] == "external-" + "x" * 300
    stable, again = await asyncio.gather(
        client.post(prefix + "/sessions", json=stable_body),
        client.post(prefix + "/sessions", json=stable_body),
    )
    assert stable.status_code == again.status_code == 200
    assert stable.json()["session"]["id"] == again.json()["session"]["id"]
    conflict = await client.post(
        prefix + "/sessions", json={**stable_body, "externalSessionId": "different-history"}
    )
    assert (
        conflict.status_code == 409
        and conflict.json()["detail"] == "clientMessageId was already used for a different request"
    )
    other = await client.post(
        prefix + "/sessions",
        json={**stable_body, "connectorId": connectors[1], "projectId": projects[1]},
    )
    assert (
        other.status_code == 200 and other.json()["session"]["id"] != stable.json()["session"]["id"]
    )
    for altered, status in (
        ({"projectId": "foreign"}, 404),
        ({"projectId": projects[1]}, 422),
        ({"cwd": "/different"}, 422),
    ):
        response = await client.post(prefix + "/sessions", json={**body, **altered})
        assert response.status_code == status, response.text
    start = await client.post(
        prefix + "/sessions/create-and-start",
        json={
            key: value
            for key, value in {**stable_body, "content": "不能跨模式复用"}.items()
            if key != "externalSessionId"
        },
    )
    assert (
        start.status_code == 409
        and start.json()["detail"] == "clientMessageId was already used for a different request"
    )
    state = await client.get(prefix + "/sessions/" + observed["session"]["id"] + "/snapshot")
    assert state.status_code == 200 and state.json()["state"]["selections"] == body["selections"]
    call.assert_not_awaited()
    # 非法目标必须在任何RPC之前拒绝，不能悄悄覆盖cwd或选择另一个配置。
    start_body = {
        "connectorId": connectors[0],
        "projectId": projects[0],
        "runtime": "dsh",
        "clientMessageId": "start-target",
        "content": "合成无外部调用",
    }
    for altered, status in (
        ({"projectId": None}, 422),
        ({"projectId": projects[1]}, 422),
        ({"cwd": "/wrong"}, 422),
        ({"runtimeId": "missing"}, 409),
    ):
        rejected = await client.post(
            prefix + "/sessions/create-and-start", json={**start_body, **altered}
        )
        assert rejected.status_code == status, rejected.text
    call.assert_not_awaited()
    # 正向执行只替换RPC传输，真实目标校验、会话写入和执行收据仍走生产实现。
    original_view = devices.view
    monkeypatch.setattr(devices, "view", lambda row: {**original_view(row), "status": "online"})
    call.side_effect = None
    call.return_value = {"accepted": True, "externalSessionId": "created-controlled"}
    accepted = await client.post(
        prefix + "/sessions/create-and-start", json={**start_body, "cwd": "/synthetic/./import"}
    )
    assert accepted.status_code == 200, accepted.text
    assert call.await_count == 1 and call.call_args.args[3]["cwd"] == "/synthetic/import"
    retry = await client.post(
        prefix + "/sessions/create-and-start", json={**start_body, "cwd": "/synthetic/import"}
    )
    assert (
        retry.status_code == 200
        and retry.json()["session"]["id"] == accepted.json()["session"]["id"]
    )
    assert call.await_count == 1
    opposite = await client.post(
        prefix + "/sessions", json={**body, "clientMessageId": "start-target"}
    )
    assert opposite.status_code == 409 and call.await_count == 1
