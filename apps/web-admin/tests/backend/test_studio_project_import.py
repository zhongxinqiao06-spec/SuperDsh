"""两个隔离数据库验证 dry-run、跨账号映射、文件发布失败回滚和手工续编。"""

import asyncio
import hashlib
import json
import os
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from conftest import bootstrap, upgrade_database
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.main import create_app
from app.modules.studio.entity.do.models import MediaJob, StudioProject
from tooling import import_studio_project as importer
from tooling.export_studio_project import export_bundle
from tooling.import_studio_project import (
    Transfer,
    check_file_references,
    import_bundle,
    load_bundle,
)


def test_import_rejects_non_foreign_key_file_links() -> None:
    values: dict[str, list[dict[str, Any]]] = {
        "web_file_entries": [{"id": "image", "previous_file_id": None}],
        "web_file_references": [{"file_id": "image", "resource_id": "project"}],
    }
    check_file_references(values, "project")
    values["web_file_references"][0]["resource_id"] = "other-project"
    with pytest.raises(ValueError, match="超出"):
        check_file_references(values, "project")
    values["web_file_references"] = []
    values["web_file_entries"][0]["previous_file_id"] = "missing-file"
    with pytest.raises(ValueError, match="前一文件"):
        check_file_references(values, "project")


@asynccontextmanager
async def target_platform(
    settings: Settings, directory: Path
) -> AsyncIterator[tuple[FastAPI, AsyncClient]]:
    """目标库与源库完全分离，结束后回收数据库与应用生命周期。"""
    base = make_url(os.environ["WEB_ADMIN_TEST_DATABASE_URL"])
    name = "validation_import_" + uuid4().hex
    control = create_async_engine(base, isolation_level="AUTOCOMMIT")
    async with control.connect() as connection:
        await connection.exec_driver_sql(f'CREATE DATABASE "{name}"')
        try:
            address = base.set(database=name).render_as_string(hide_password=False)
            await upgrade_database(address)
            config = settings.model_copy(update={"database_url": address, "data_dir": directory})
            application = create_app(config)
            async with (
                application.router.lifespan_context(application),
                AsyncClient(
                    transport=ASGITransport(app=application), base_url="http://localhost:5175"
                ) as client,
            ):
                await bootstrap(client)
                yield application, client
        finally:
            await connection.exec_driver_sql(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    await control.dispose()


async def test_import_is_atomic_and_resumes_manual_work(
    platform: tuple[FastAPI, AsyncClient],
    platform_configuration: Settings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, client = platform
    await bootstrap(client)
    media = app.state.services.media_jobs
    await media.close()
    project = (
        await client.post(
            "/api/studio/projects", json={"title": "迁移作品", "requestKey": "source-film"}
        )
    ).json()["id"]
    role = (
        await client.post(
            "/api/studio/assets",
            json={"project": project, "kind": "character", "name": "角色", "voice": "voice-a"},
        )
    ).json()["id"]
    async with media.database.sessions.begin() as session:
        owner = await session.scalar(select(StudioProject.owner).where(StudioProject.id == project))
        for identity, kind, subject in [
            ("sample-video", "video", "shot-a"),
            ("sample-speech", "speech", "line-a"),
        ]:
            session.add(
                MediaJob(
                    id=identity,
                    project=project,
                    request_key=identity,
                    subject=subject,
                    kind=kind,
                    revision=1,
                    state="ready",
                    provider_id=None,
                    payload={"duration": 1000 if kind == "speech" else 5000, "owner": owner},
                )
            )
    document = {
        "script": "测试短片",
        "assets": [role],
        "shots": [
            {
                "id": "shot-a",
                "action": "海边散步",
                "duration": 5000,
                "references": [role],
                "candidate": "sample-video",
                "lines": [
                    {
                        "id": "line-a",
                        "role": role,
                        "text": "出发吧",
                        "voice": "voice-a",
                        "audio": "sample-speech",
                    }
                ],
            }
        ],
    }
    revision = (await client.get("/api/studio/projects/" + project)).json()["revision"]
    saved = await client.put(
        "/api/studio/projects/" + project, json={"revision": revision, "document": document}
    )
    assert saved.status_code == 200, saved.text
    media.root.mkdir(parents=True, exist_ok=True)
    (media.root / "sample-video.mp4").write_bytes(b"synthetic-video")
    (media.root / "sample-speech.wav").write_bytes(b"synthetic-speech")
    bundle = tmp_path / "bundle"
    await export_bundle(media.database, project, platform_configuration.data_dir, bundle)
    target_root = tmp_path / "target"
    async with target_platform(platform_configuration, target_root) as (target, remote):
        database = target.state.services.media_jobs.database
        await target.state.services.media_jobs.close()
        async with database.sessions() as session:
            target_owner = await session.scalar(text("SELECT id FROM users LIMIT 1"))
            assert target_owner and target_owner != owner
        before = await import_bundle(database, bundle, target_root, target_owner)
        assert before["status"] == "dry-run-passed" and before["newFiles"] == 0
        async with database.sessions() as session:
            assert not await session.scalar(
                select(StudioProject.id).where(StudioProject.id == project)
            )
        # 目标必须存在可明确映射的模型版本，不能把角色音色外键置空蒙混通过。
        data = json.loads((bundle / "rows.json").read_text(encoding="utf-8"))
        data["studio_entity_versions"][0].update(
            voice_configuration_id="source-speech",
            voice_configuration_revision=1,
        )
        for job in data["studio_media_jobs"]:
            if job["kind"] == "speech":
                job["payload"]["binding"] = {
                    "configurationId": "source-speech",
                    "revision": 1,
                    "capability": "speech.synthesize",
                }
        (bundle / "rows.json").write_text(json.dumps(data), encoding="utf-8")
        manifest_path = bundle / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        row_content = (bundle / "rows.json").read_bytes()
        next(entry for entry in manifest["dataFiles"] if entry["path"] == "rows.json").update(
            bytes=len(row_content),
            sha256=hashlib.sha256(row_content).hexdigest(),
        )
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with pytest.raises(ValueError, match="缺少关联"):
            await import_bundle(database, bundle, target_root, target_owner)
        connection = await remote.post(
            "/api/admin/models/connections",
            json={
                "name": "目标合成供应商",
                "adapter": "openai-completions",
                "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
                "apiKey": "synthetic",
            },
        )
        assert connection.status_code == 200, connection.text
        configuration = await remote.post(
            "/api/admin/models/configurations",
            json={
                "name": "目标配音",
                "connectionId": connection.json()["id"],
                "capability": "speech.synthesize",
                "modelId": "synthetic-speech",
                "parameters": {"voices": "voice-a"},
            },
        )
        assert configuration.status_code == 200, configuration.text
        binding_map = {"source-speech@1": configuration.json()["id"] + "@1"}
        assert (
            await import_bundle(database, bundle, target_root, target_owner, bindings=binding_map)
        )["status"] == "dry-run-passed"
        original_publish = importer.publish_files

        def failing_publish(transfer: Transfer, runtime: Path, created: list[Path]) -> None:
            original_publish(transfer, runtime, created)
            raise RuntimeError("模拟发布后事务失败")

        monkeypatch.setattr(importer, "publish_files", failing_publish)
        with pytest.raises(RuntimeError, match="模拟发布"):
            await import_bundle(
                database, bundle, target_root, target_owner, apply=True, bindings=binding_map
            )
        assert not (target_root / "studio/media/sample-video.mp4").exists()
        async with database.sessions() as session:
            assert not await session.scalar(
                select(StudioProject.id).where(StudioProject.id == project)
            )
            assert await session.scalar(text("SELECT count(*) FROM users")) == 1
        published, release = threading.Event(), threading.Event()

        def delayed_publish(transfer: Transfer, runtime: Path, created: list[Path]) -> None:
            original_publish(transfer, runtime, created)
            published.set()
            if not release.wait(10):
                raise RuntimeError("取消测试未释放复制线程")

        monkeypatch.setattr(importer, "publish_files", delayed_publish)
        cancelled = asyncio.create_task(
            import_bundle(
                database,
                bundle,
                target_root,
                target_owner,
                apply=True,
                bindings=binding_map,
            )
        )
        try:
            assert await asyncio.to_thread(published.wait, 10)
            cancelled.cancel()
            await asyncio.sleep(0)
            assert not cancelled.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        assert not (target_root / "studio/media/sample-video.mp4").exists()
        async with database.sessions() as session:
            assert not await session.scalar(
                select(StudioProject.id).where(StudioProject.id == project)
            )
        monkeypatch.setattr(importer, "publish_files", original_publish)
        report = await import_bundle(
            database, bundle, target_root, target_owner, apply=True, bindings=binding_map
        )
        assert report["status"] == "imported" and report["newFiles"] == 2
        opened = await remote.get("/api/studio/projects/" + project)
        assert opened.status_code == 200, opened.text
        body = opened.json()
        assert body["sessionId"] is None
        assert body["document"]["shots"][0]["candidate"] == "sample-video"
        assert body["document"]["shots"][0]["lines"][0]["audio"] == "sample-speech"
        body["document"]["shots"][0]["action"] = "导入后继续手工编辑"
        assert (
            await remote.put(
                "/api/studio/projects/" + project,
                json={"revision": body["revision"], "document": body["document"]},
            )
        ).status_code == 200
        media_path = "/api/studio/projects/" + project + "/media/sample-video"
        assert (await remote.post(media_path + "/access")).status_code == 200
        assert (await remote.get(media_path)).content == b"synthetic-video"
        with pytest.raises(ValueError, match="同 ID"):
            await import_bundle(database, bundle, target_root, target_owner, apply=True)
    (bundle / "runtime/studio/media/sample-video.mp4").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="摘要"):
        load_bundle(bundle)
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    assert "users" not in manifest["rows"]
