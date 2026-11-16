"""隔离数据库验证项目迁移边界、未知收据保留以及文件复制安全。"""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select

from app.modules.models.entity.do.model_do import ModelOperationRow
from app.modules.studio.entity.do.models import MediaJob, StudioProject
from tooling.export_studio_project import ALLOWLIST, copy_checked, export_bundle, rows, sanitized


def test_transfer_sanitizes_nested_credentials_and_rejects_path_escape(tmp_path: Path) -> None:
    removed: list[str] = []
    result = sanitized(
        {
            "payload": {"apiKey": "synthetic-secret", "prompt": "合法内容"},
            "provider_id": "sealed-local-value",
            "owner": "source-owner",
        },
        removed,
    )
    assert result == {
        "payload": {"apiKey": None, "prompt": "合法内容"},
        "provider_id": None,
        "owner": "source-owner",
    }
    assert removed == ["payload.apiKey", "provider_id"]
    (tmp_path / "source").mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("unrelated", encoding="utf-8")
    with pytest.raises(ValueError, match="越界"):
        copy_checked(tmp_path / "source", "../outside.txt", tmp_path / "target")
    assert not (tmp_path / "target").exists()
    assert "users" not in ALLOWLIST and "model_connections" not in ALLOWLIST


async def test_transfer_exports_only_selected_project_without_execution_secrets(
    platform: tuple[FastAPI, AsyncClient], tmp_path: Path
) -> None:
    app, client = platform
    await bootstrap(client)
    selected = (
        await client.post(
            "/api/studio/projects", json={"title": "仅此作品", "requestKey": "selected"}
        )
    ).json()["id"]
    other = (
        await client.post(
            "/api/studio/projects", json={"title": "其他作品不导出", "requestKey": "other"}
        )
    ).json()["id"]
    media = app.state.services.media_jobs
    await media.close()
    database = media.database
    async with database.sessions.begin() as session:
        owner = await session.scalar(
            select(StudioProject.owner).where(StudioProject.id == selected)
        )
        assert owner
        session.add_all(
            [
                MediaJob(
                    id="included",
                    project=selected,
                    request_key="included",
                    subject="timeline",
                    kind="export",
                    revision=1,
                    state="ready",
                    payload={"owner": owner, "apiKey": "never-export-sentinel"},
                    provider_id="sealed-receipt-sentinel",
                ),
                MediaJob(
                    id="unrelated",
                    project=other,
                    request_key="unrelated",
                    subject="timeline",
                    kind="export",
                    revision=1,
                    state="unknown",
                    payload={"private": "other-project-secret"},
                ),
                ModelOperationRow(
                    id="unknown-research",
                    owner_id=owner,
                    session_id="studio-context:" + selected,
                    configuration_id="synthetic",
                    configuration_revision=1,
                    state="submission-unknown",
                    request_id=None,
                    request_hash="f" * 64,
                    result={},
                    usage={},
                    error="需要核对",
                    updated_at=datetime.now(UTC),
                    receipt_ciphertext="encrypted-not-portable",
                ),
            ]
        )
    runtime = tmp_path / "runtime"
    (runtime / "studio/media").mkdir(parents=True)
    (runtime / "studio/media/included.mp4").write_bytes(b"synthetic-media-fixture")
    output = tmp_path / "transfer"
    manifest = await export_bundle(database, selected, runtime, output)
    exported = (output / "rows.json").read_text(encoding="utf-8")
    values = json.loads(exported)
    assert len(values["studio_projects"]) == 1
    assert values["studio_projects"][0]["id"] == selected
    assert [job["id"] for job in values["studio_media_jobs"]] == ["included"]
    assert "never-export-sentinel" not in exported
    assert "sealed-receipt-sentinel" not in exported
    assert "other-project-secret" not in exported
    assert "model_operations" not in values
    evidence = json.loads((output / "evidence/model-operations.json").read_text(encoding="utf-8"))
    assert evidence[0]["state"] == "submission-unknown" and evidence[0]["has_encrypted_receipt"]
    assert "encrypted-not-portable" not in json.dumps(evidence)
    assert manifest["files"][0]["bytes"] == len(b"synthetic-media-fixture")
    async with database.sessions() as session:
        assert (
            await session.scalar(select(MediaJob.provider_id).where(MediaJob.id == "included"))
            == "sealed-receipt-sentinel"
        )
        assert (
            await session.scalar(
                select(ModelOperationRow.state).where(ModelOperationRow.id == "unknown-research")
            )
            == "submission-unknown"
        )
        with pytest.raises(ValueError, match="允许范围"):
            await rows(session, "users", "id", [owner])
        assert await rows(session, "studio_projects", "id", []) == []
    with pytest.raises(ValueError, match="拒绝覆盖"):
        await export_bundle(database, selected, runtime, output)
    with pytest.raises(ValueError, match="未完成任务"):
        await export_bundle(database, other, runtime, tmp_path / "other-transfer")
    assert not (tmp_path / "other-transfer").exists()
