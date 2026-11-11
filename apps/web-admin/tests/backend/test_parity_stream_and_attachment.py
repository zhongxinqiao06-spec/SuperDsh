"""第三阶段真实协议回归：旧事件摘要、网络握手、原生附件与撤权。"""

import base64
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from app.api.multipart import attachment_parts
from app.infrastructure.errors import DomainError
from app.modules.conversations.service.event_protocol import event_envelope
from app.modules.conversations.service.ticket_service import TicketService
from fixtures.device_connector import loopback_application

ROOT = Path(__file__).resolve().parents[4]


@pytest.mark.parametrize(
    "payload",
    [
        {"clientId": "桌面", "eventCursor": "seq:7"},
        {"text": "中文 😀", "empty": None, "items": [True, 2]},
    ],
)
def test_event_envelope_matches_frozen_implementation(
    payload: dict[str, object],
) -> None:
    """旧实际函数作为oracle，序列/类型/内容相同必须得到同一稳定事件标识。"""
    result = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/event-oracle.ts")],
        input=json.dumps(
            {
                "session": "session-synthetic",
                "sequence": 7,
                "type": "session.subscribed",
                "payload": payload,
            },
            ensure_ascii=False,
        )
        + "\n",
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
        timeout=20,
        cwd=ROOT,
    )
    expected = json.loads(result.stdout)
    observed = event_envelope("session-synthetic", 7, "session.subscribed", payload)
    # 只验证各自调用时间处于本轮窗口，不删除事件序列、摘要或任何业务内容。
    for value in (expected, observed):
        assert (
            abs(
                (
                    datetime.now(UTC) - datetime.fromisoformat(str(value["emittedAt"]))
                ).total_seconds()
            )
            < 20
        )
    assert {key: value for key, value in expected.items() if key != "emittedAt"} == {
        key: value for key, value in observed.items() if key != "emittedAt"
    }


def test_multipart_rejects_incomplete_and_excess_files_without_disk() -> None:
    """截断尾界和超文件数必须失败，解析不把临时文件写到系统或源码目录。"""
    prefix = b'--synthetic\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n'
    assert (
        attachment_parts("multipart/form-data; boundary=synthetic", prefix + b"--synthetic--\r\n")[
            0
        ].content
        == b"hello"
    )
    with pytest.raises(DomainError, match="incomplete multipart"):
        attachment_parts("multipart/form-data; boundary=synthetic", prefix)
    with pytest.raises(DomainError, match="too many attachments"):
        attachment_parts(
            "multipart/form-data; boundary=synthetic",
            prefix * 11 + b"--synthetic--\r\n",
        )


async def seed_session(client: AsyncClient, prefix: str) -> str:
    """合成Connector只通过真实认证/通知入口创建隔离会话，不直接写领域表。"""
    await bootstrap(client, prefix)
    created = (await client.post(prefix + "/connectors", json={"name": "合成设备"})).json()
    response = await client.post(
        prefix + "/connector/auth",
        headers={
            "Authorization": f"Connector {created['connector']['id']}:{created['connectorToken']}"
        },
    )
    access = response.json()["accessToken"]
    identifier = "parity-session"
    projected = await client.post(
        prefix + "/connector/ingest",
        headers={"Authorization": "Bearer " + access},
        json={
            "notifications": [
                {
                    "method": "session.created",
                    "params": {
                        "sessionId": identifier,
                        "runtime": "controlled",
                        "title": "协议验收",
                    },
                }
            ]
        },
    )
    assert projected.status_code == 200 and projected.json()["accepted"] == 1
    return identifier


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_attachment_native_protocol_and_revocation(
    platform: tuple[FastAPI, AsyncClient], prefix: str
) -> None:
    """同一handler保留multipart/JSON/302/Range，跨文件票据和登出后下载均拒绝。"""
    _, client = platform
    session = await seed_session(client, prefix)
    content = "附件正文0123456789".encode()
    response = await client.post(
        f"{prefix}/sessions/{session}/attachments",
        files={"files": ("附件.txt", content, "text/plain")},
    )
    assert response.status_code == 200, response.text
    file_id = response.json()["attachments"][0]["fileId"]
    attachment = f"{prefix}/sessions/{session}/attachments/{file_id}"
    downloaded = (await client.get(attachment)).json()
    assert base64.b64decode(downloaded["contentBase64"]) == content
    assert downloaded["fileId"] == file_id and downloaded["sessionId"] == session
    opened = await client.get(attachment + "/open")
    assert opened.status_code == 302 and opened.headers["location"].startswith(
        prefix + "/sessions/local/"
    )
    location = opened.headers["location"]
    assert client.headers["Authorization"][7:] not in location
    partial = await client.get(location, headers={"Range": "bytes=1-7"})
    assert partial.status_code == 206 and partial.content == content[1:8]
    assert partial.headers["content-range"] == f"bytes 1-7/{len(content)}"
    assert (await client.get(location.replace(file_id, "foreign-file"))).status_code == 404
    assert (await client.get(location, headers={"Range": "bytes=9999-10000"})).status_code == 416
    assert (
        await client.get(location, headers={"Range": "bytes=" + "9" * 5000 + "-"})
    ).status_code == 416
    malformed = await client.post(
        f"{prefix}/sessions/{session}/attachments",
        json={"name": "invalid.txt", "contentBase64": "非ASCII不是Base64"},
    )
    assert (
        malformed.status_code == 422 and malformed.json()["detail"] == "invalid attachment encoding"
    )
    await client.post(prefix + "/auth/logout-all")
    assert (await client.get(location)).status_code == 401


@pytest.mark.parametrize(
    "credential",
    [
        "conn.².signature",
        "conn." + "9" * 5000 + ".signature",
        "conn.9999999999.非ASCII",
    ],
)
async def test_connector_malformed_credential_is_rejected_before_lookup(
    platform: tuple[FastAPI, AsyncClient], credential: str
) -> None:
    """非ASCII签名、Unicode数字及超长有效期都必须产生认证失败而非内部异常。"""
    application, _ = platform
    with pytest.raises(DomainError) as caught:
        await application.state.services.devices.authenticate(credential)
    assert caught.value.status == 401


async def test_socket_ticket_scope_single_use_and_native_client(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """真实旧桌面只发送ticket：首帧保留信封；错作用域尝试也消费票据。"""
    application, client = platform
    session = await seed_session(client, "/api")
    scope: dict[str, object] = {"sessionId": session}
    issued = (
        await client.post("/api/ws-ticket", json={"clientId": "native-client", "scope": scope})
    ).json()
    lifetime = (
        datetime.fromisoformat(issued["expiresAt"]) - datetime.fromisoformat(issued["serverTime"])
    ).total_seconds()
    assert lifetime == 60
    async with loopback_application(application) as origin:
        url = (
            origin.replace("http:", "ws:")
            + f"/api/v2/sessions/{session}/ws?ticket={issued['ticket']}"
        )
        async with connect(url) as socket:
            first = json.loads(await socket.recv())
            assert first["type"] == "session.subscribed"
            assert first["sessionId"] == session and first["payload"]["clientId"] == "native-client"
            assert first["payload"]["eventCursor"] == first["cursor"]
            assert first["eventId"].startswith(f"evt_{first['sequence']}_")
        with pytest.raises(InvalidStatus) as replay:
            async with connect(url):
                pytest.fail("已消费票据不能重新连接")
        assert replay.value.response.status_code == 401
    issued = (
        await client.post("/api/ws-ticket", json={"clientId": "native-client", "scope": scope})
    ).json()
    tickets = cast(TicketService, application.state.services.conversations.tickets)
    with pytest.raises(DomainError):
        await tickets.consume(issued["ticket"], "", {"dashboard": True})
    with pytest.raises(DomainError):
        await tickets.consume(issued["ticket"], "", scope)


async def test_all_socket_missing_credentials_keep_http_status(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """七个冻结入口和规范入口均实测握手拒绝，不把框架默认403当作旧401。"""
    application, _ = platform
    catalog = json.loads(
        (ROOT / "apps/web-admin/deployment/compatibility-routes.json").read_text(encoding="utf-8")
    )
    import re

    async with loopback_application(application) as origin:
        for mapping in catalog["routes"]:
            if mapping["transport"] != "websocket":
                continue
            for key in ("legacy", "canonical"):
                path = re.sub(r"\{[^}]+\}", "missing", mapping[key])
                with pytest.raises(InvalidStatus) as denied:
                    async with connect(origin.replace("http:", "ws:") + path):
                        pytest.fail("缺少凭据不能建立WebSocket")
                assert denied.value.response.status_code == 401, path
