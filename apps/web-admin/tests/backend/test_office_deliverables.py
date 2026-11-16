"""办公成果目录使用隔离 PostgreSQL，覆盖归属、旧会话、撤权、排序与回收。"""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import cast

import pytest
from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.do.models import SessionRow
from app.modules.files.entity.do.models import FileEntryRow, FileReferenceRow
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.entity.do.models import BindingRow
from app.modules.skills.entity.do.models import ArtifactRow, SkillRunRow


async def test_office_deliverables_are_scoped_and_bounded(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    account = await bootstrap(client)
    owner = cast(str, account["userId"])
    path = "/api/office/recent-deliverables"
    assert (await client.get(path)).json() == {"items": []}
    assert (await client.get(path, params={"limit": 11})).status_code == 422
    now = datetime.now(UTC)
    device = await client.post("/api/connectors", json={"name": "办公成果设备"})
    assert device.status_code in {200, 201}, device.text
    connector_id = device.json()["connector"]["id"]
    entries: list[tuple[str, dict[str, object], str, str, bool]] = [
        ("legacy", {}, owner, owner, False),
        ("current", {"product": "office"}, owner, owner, False),
        ("studio", {"product": "entertainment"}, owner, owner, False),
        ("removed", {"historyDeletedAt": now.isoformat()}, owner, owner, False),
        ("other-session", {}, "other-owner", owner, False),
        ("other-file", {}, owner, "other-owner", False),
        ("trash", {}, owner, owner, True),
        ("removed-device", {}, owner, owner, False),
    ]
    async with app.state.database.sessions.begin() as db:
        for offset, (name, source, session_owner, file_owner, deleted) in enumerate(entries):
            created = now + timedelta(seconds=offset)
            db.add(
                SessionRow(
                    id=name,
                    owner_id=session_owner,
                    connector_id=connector_id if name != "removed-device" else "missing",
                    runtime_id="dsh",
                    runtime_type="dsh",
                    title=name,
                    cwd="/office",
                    source=source,
                    created_at=now,
                    updated_at=now,
                )
            )
            db.add(
                FileEntryRow(
                    id=name,
                    owner_id=file_owner,
                    storage_id="local",
                    object_key=name,
                    name=name,
                    size=5,
                    sha256="a" * 64,
                    media_type="text/plain",
                    category="document",
                    created_at=created,
                    deleted_at=created if deleted else None,
                )
            )
            db.add(
                ArtifactRow(
                    id=name,
                    owner_id=owner,
                    session_id=name,
                    media_type="text/plain",
                    object_key=name,
                    sha256="a" * 64,
                    metadata_json={
                        "fileId": name,
                        "filename": name + ".txt",
                        "deliverable": name != "current",
                        "preview": {"objectKey": "private"},
                    },
                )
            )
        db.add(
            FileReferenceRow(
                file_id="current",
                owner_id=owner,
                kind="artifact",
                resource_id="current",
            )
        )
    generated = (await client.get("/api/files", params={"source": "artifact"})).json()
    assert [item["id"] for item in generated["items"]] == ["current"]
    personal = (await client.get("/api/files", params={"source": "personal"})).json()
    assert "current" not in {item["id"] for item in personal["items"]}
    assert "legacy" in {item["id"] for item in personal["items"]}
    # 早期技能成果只持有技能运行和对象路径，仍可经会话读取并下载真实字节。
    legacy_bytes = b"synthetic historic pdf"
    content_root = app.state.services.evidence.object_root / owner
    content_root.mkdir(parents=True, exist_ok=True)
    (content_root / "legacy.pdf").write_bytes(legacy_bytes)
    async with app.state.database.sessions.begin() as db:
        db.add(
            BindingRow(
                id="old-binding", owner_id=owner, session_id="legacy", version=1, snapshots=[]
            )
        )
        await db.flush()
        db.add(
            SkillRunRow(
                id="old-run",
                owner_id=owner,
                session_id="legacy",
                binding_id="old-binding",
                request_id="old",
                program={},
                state="completed",
                stage_index=0,
                revision=1,
                version=1,
                outputs={},
            )
        )
        await db.flush()
        for file_id, identifier in (
            (None, "historical"),
            ("missing-file", "broken-file"),
            ("trash", "recycled-legacy"),
        ):
            metadata = {"filename": "legacy.pdf"}
            if file_id:
                metadata["fileId"] = file_id
            db.add(
                ArtifactRow(
                    id=identifier,
                    owner_id=owner,
                    session_id="legacy",
                    run_id="old-run",
                    media_type="application/pdf",
                    object_key="legacy.pdf",
                    sha256=sha256(legacy_bytes).hexdigest(),
                    metadata_json=metadata,
                )
            )
    downloaded = await client.get("/api/sessions/legacy/agent-artifacts/historical/download")
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == legacy_bytes
    assert (
        await client.get("/api/sessions/legacy/agent-artifacts/historical/preview")
    ).status_code == 200
    response = await client.get(path)
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [item["id"] for item in items] == ["current", "legacy", "historical"]
    assert items[-1]["createdAt"] is None
    assert items[0]["deliverable"] is False
    assert items[0]["name"] == "current.txt"
    assert "objectKey" not in items[0] and "preview" not in items[0]
    assert [
        item["id"] for item in (await client.get(path, params={"limit": 1})).json()["items"]
    ] == ["current"]
    for missing in ("products.office", "sessions.read", "files.read"):
        grants = tuple(
            p
            for p in (
                "products.office",
                "products.entertainment",
                "sessions.read",
                "files.read",
            )
            if p != missing
        )
        restricted = Account(owner, "testadmin", ("member",), grants, 1)
        with pytest.raises(DomainError) as failure:
            await app.state.services.evidence.recent_office_deliverables(restricted, 1)
        assert failure.value.status == 403

    # 真实登录其他办公成员与娱乐使用者，覆盖目录、预览、下载三个 HTTP 入口。
    for role, username in (
        ("member", "office-peer"),
        ("entertainment_creator", "studio-peer"),
    ):
        password = "Synthetic-peer-password!"
        created_user = await client.post(
            "/api/admin/users",
            json={
                "username": username,
                "displayName": username,
                "password": password,
                "roles": [role],
            },
        )
        assert created_user.status_code == 201, created_user.text
        identity = await complete_initial_login(client, username, password)
        headers = {"Authorization": "Bearer " + str(identity["accessToken"])}
        listing = await client.get(path, headers=headers)
        if role == "member":
            assert listing.status_code == 200 and listing.json()["items"] == []
        else:
            assert listing.status_code == 403
        for action in ("preview", "download"):
            response = await client.get(
                f"/api/sessions/current/agent-artifacts/current/{action}",
                headers=headers,
            )
            assert response.status_code == 404, response.text
            assert "current.txt" not in response.text
