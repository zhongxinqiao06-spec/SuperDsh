"""文件预览、Shell 收据和终端 Relay 在隔离数据库与真实回环传输上验收。"""

import asyncio
import base64
import json
import os
from typing import cast

from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from websockets.asyncio.client import connect

from fixtures.device_connector import connector_peer


async def native_connector(application: FastAPI, client: AsyncClient) -> str:
    login = await bootstrap(client)
    account = await application.state.services.identity.authenticate(login["accessToken"])
    # 这些用例验证平台工作区传输，显式登记隔离身份而不假装启动真实 DSH。
    await application.state.services.devices.ensure_native(account.user_id)
    return cast(str, application.state.services.devices.native_ids(account.user_id)[0])


async def test_local_transfer_preview_consumption_and_path_binding(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    connector = await native_connector(application, client)
    prefix = f"/api/connectors/{connector}/fs"
    assert (
        await client.post(prefix + "/write", json={"path": "preview.txt", "content": "预览合同"})
    ).status_code == 200
    prepared = await client.post(prefix + "/read", json={"path": "preview.txt"})
    assert prepared.status_code == 200, prepared.text
    transfer = prepared.json()["result"]
    downloaded = await client.get(transfer["downloadUrl"])
    assert downloaded.content == "预览合同".encode()
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    assert (await client.get(transfer["downloadUrl"])).status_code == 404
    token = (await client.post(prefix + "/preview-token", json={"path": "preview.txt"})).json()[
        "previewToken"
    ]
    exchanged = await asyncio.gather(
        *(
            client.post("/api/connectors/fs/preview-session", json={"previewToken": token})
            for _ in range(2)
        )
    )
    assert sorted(response.status_code for response in exchanged) == [200, 401]
    access = next(
        response.json()["previewAccessToken"]
        for response in exchanged
        if response.status_code == 200
    )
    text = await client.post(
        "/api/connectors/fs/preview/readText", json={"previewAccessToken": access}
    )
    assert text.json()["content"] == "预览合同"
    assert (
        await client.post(
            "/api/connectors/fs/preview/readText",
            json={"previewAccessToken": access, "path": "other.txt"},
        )
    ).status_code == 422
    assert (await client.post(prefix + "/read", json={"path": "../escape.txt"})).status_code == 403
    assert (
        await client.post(prefix + "/read", json={"root": "sub", "path": "../preview.txt"})
    ).status_code == 403
    assert (await client.post("/api/auth/logout", json={})).status_code == 204
    assert (
        await client.post(
            "/api/connectors/fs/preview/readText", json={"previewAccessToken": access}
        )
    ).status_code == 401


async def test_local_shell_actual_process_and_durable_idempotency(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    connector = await native_connector(application, client)
    prefix = f"/api/connectors/{connector}/shell"
    command = (
        "[System.IO.File]::AppendAllText('once.txt', 'once')"
        if os.name == "nt"
        else "printf once >> once.txt"
    )
    payload = {"command": command, "operationId": "stable-shell"}
    responses = await asyncio.gather(
        *(client.post(prefix + "/tasks", json=payload) for _ in range(2))
    )
    assert all(response.status_code == 200 for response in responses), [
        response.text for response in responses
    ]
    identities = {response.json()["taskId"] for response in responses}
    assert len(identities) == 1
    identifier = identities.pop()
    waited = await client.get(prefix + f"/tasks/{identifier}/wait", params={"timeoutMs": 15000})
    assert waited.status_code == 200 and waited.json()["status"] == "completed", waited.text
    output = await client.post(
        f"/api/connectors/{connector}/fs/readText", json={"path": "once.txt"}
    )
    assert output.json()["content"] == "once", output.text
    assert (
        await client.post(prefix + "/tasks", json={**payload, "command": "echo changed"})
    ).status_code == 409
    await application.state.services.devices.operations.shell.initialize()
    assert (await client.post(prefix + "/tasks", json=payload)).json()["status"] == "completed"
    direct = await client.post(prefix + "/exec", json={"command": "echo LOCAL_SHELL_OK"})
    assert direct.status_code == 200 and "LOCAL_SHELL_OK" in direct.json()["result"]["stdout"], (
        direct.text
    )


async def test_local_shell_timeout_records_failure_and_closes_process(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    connector = await native_connector(application, client)
    prefix = f"/api/connectors/{connector}/shell"
    command = "Start-Sleep -Seconds 60" if os.name == "nt" else "sleep 60"
    started = await client.post(prefix + "/tasks", json={"command": command, "timeoutMs": 1})
    identifier = started.json()["taskId"]
    result = await client.get(prefix + f"/tasks/{identifier}/wait", params={"timeoutMs": 15000})
    assert result.json()["status"] == "failed", result.text
    assert result.json()["error"]["code"] == "execution_timeout"
    assert not application.state.services.devices.operations.shell.tasks


async def test_remote_download_uses_real_connector_upload_and_integrity(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    await bootstrap(client)
    async with connector_peer(application, client) as (connector, peer):
        prefix = f"/api/connectors/{connector}/fs"
        prepared = await client.post(
            prefix + "/read", json={"root": "C:\\workspace", "path": "remote.txt"}
        )
        assert prepared.status_code == 200, prepared.text
        result = prepared.json()["result"]
        downloaded = await client.get(result["downloadUrl"])
        assert downloaded.status_code == 200 and downloaded.content == peer.content, downloaded.text
        assert peer.upload_status == 200
        assert peer.calls[0][1]["path"] == "C:\\workspace\\remote.txt"
        peer.upload_content = b"wrong-bytes"
        bad = (
            await client.post(prefix + "/read", json={"root": "/workspace", "path": "remote.txt"})
        ).json()["result"]
        assert (await client.get(bad["downloadUrl"])).status_code == 502
        assert peer.upload_status == 422
        assert not application.state.services.devices.operations.files.transfers
        assert (
            await client.post(
                prefix + "/read",
                json={"root": "C:\\workspace", "path": "D:\\outside.txt"},
            )
        ).status_code == 403
        assert (
            await client.post(
                prefix + "/read",
                json={"root": "/workspace", "path": "../../outside.txt"},
            )
        ).status_code == 403


async def test_remote_terminal_relay_and_shell_contracts(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    await bootstrap(client)
    async with connector_peer(application, client) as (connector, peer):
        prefix = f"/api/connectors/{connector}"
        created = await client.post(
            prefix + "/terminals",
            json={"root": "/workspace", "cwd": "project", "name": "远程验证"},
        )
        assert created.status_code == 200, created.text
        identifier = created.json()["terminal"]["id"]
        address = prefix + f"/terminals/{identifier}"
        written = await client.post(address + "/write", json={"data": "远程输入"})
        assert written.status_code == 200, written.text
        snapshot = await client.get(address + "/snapshot")
        assert snapshot.json()["data"] == "远程输入", snapshot.text
        assert base64.b64decode(snapshot.json()["dataBase64"]).decode() == "远程输入"
        assert (
            await client.post(address + "/resize", json={"cols": 120, "rows": 40})
        ).status_code == 200
        assert (await client.patch(address, json={"name": "新终端名"})).status_code == 200
        assert (
            await client.patch(address + "/persistence", json={"persistence": False})
        ).status_code == 200
        assert any(
            method == "terminal.rename" and params["label"] == "新终端名"
            for method, params in peer.calls
        )
        assert any(
            frame["type"] == "start"
            and frame["root"] == "/workspace"
            and frame["cwd"] == "/workspace/project"
            for frame in peer.frames
        )
        assert (await client.get(prefix + "/terminals/not-owned/snapshot")).status_code == 404
        token = client.headers["Authorization"][7:]
        async with connect(
            peer.origin.replace("http:", "ws:") + address + "/stream?token=" + token
        ) as stream:
            first = json.loads(await stream.recv())
            assert (
                first["type"] == "replay" and base64.b64decode(first["data"]).decode() == "远程输入"
            )
            await stream.send(json.dumps({"type": "ping"}))
            for _ in range(4):
                if json.loads(await stream.recv())["type"] == "pong":
                    break
            else:
                raise AssertionError("终端流未响应 ping")
        shell = await client.post(
            prefix + "/shell/exec",
            json={"root": "/workspace", "command": "controlled command"},
        )
        assert shell.status_code == 200 and shell.json()["result"]["stdout"] == "REMOTE_SHELL_OK", (
            shell.text
        )
        assert (await client.delete(address)).status_code == 200
        assert (await client.get(address + "/snapshot")).status_code == 404


async def test_remote_runtime_configuration_remains_protocol_driven(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    await bootstrap(client)
    async with connector_peer(application, client) as (connector, peer):
        prefix = f"/api/connectors/{connector}"
        discovered = await client.post(prefix + "/runtime-types/discover")
        assert (
            discovered.status_code == 200
            and discovered.json()["runtimeTypes"][0]["runtimeType"] == "controlled"
        )
        created = await client.post(
            prefix + "/runtimes",
            json={
                "runtimeId": "controlled-two",
                "runtimeType": "controlled",
                "name": "受控实例",
                "config": {"setting": "a"},
                "active": True,
            },
        )
        assert created.status_code == 200 and created.json()["running"], created.text
        address = prefix + "/runtimes/controlled-two"
        catalog = await client.get(address + "/catalogs/model")
        assert catalog.json()["models"][0]["id"] == "controlled-model"
        saved = await client.put(
            address + "/config",
            json={"config": {"setting": "b"}, "revision": created.json()["revision"]},
        )
        assert saved.status_code == 200 and saved.json()["config"] == {"setting": "b"}, saved.text
        stale = await client.put(
            address + "/active",
            json={"active": False, "revision": created.json()["revision"]},
        )
        assert stale.status_code == 409
        assert (await client.delete(address + "/config")).status_code == 200
        assert (await client.get(address + "/catalogs/model")).status_code == 409
        assert [method for method, _ in peer.calls].count("runtime.stop") == 2
