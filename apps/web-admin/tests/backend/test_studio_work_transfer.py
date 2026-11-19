"""静态快速/整剧双库迁移：同用户映射、闭包、回滚与严格基线复用。"""

from pathlib import Path

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text
from test_studio_project_import import target_platform

from app.infrastructure.configuration import Settings
from tooling import import_studio_project as importer
from tooling.export_studio_work import export_work_bundle
from tooling.import_studio_project import Transfer, import_bundle, load_bundle


async def test_work_bundle_drafts_atomic_and_shared_baseline(
    platform: tuple[FastAPI, AsyncClient],
    platform_configuration: Settings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """只创建草稿，不调用供应商；固定版本及分集锁保留，待处理命令只作证据。"""
    app, client = platform
    await bootstrap(client)
    database = app.state.services.studio.database
    await app.state.services.media_jobs.close()
    role = await client.post(
        "/api/studio/assets",
        json={"kind": "character", "name": "文字角色", "description": "白色小狗"},
    )
    assert role.status_code == 200, role.text
    version = role.json()["id"]
    quick = await client.post(
        "/api/studio/projects", json={"title": "快速草稿", "creationMode": "quick"}
    )
    assert quick.status_code == 200, quick.text
    quick_id = quick.json()["id"]
    quick_path = "/api/studio/projects/" + quick_id + "/quick"
    state = (await client.get(quick_path)).json()
    saved = await client.put(
        quick_path,
        json={
            "revision": state["revision"],
            "requestKey": "draft-save",
            "title": "快速草稿",
            "draft": {**state["draft"], "prompt": "海岸出发", "references": [version]},
        },
    )
    assert saved.status_code == 200, saved.text
    created = await client.post(
        "/api/studio/series",
        json={"title": "短剧草稿", "plannedEpisodes": 2, "requestKey": "series-create"},
    )
    assert created.status_code == 200, created.text
    series = created.json()
    series_path = "/api/studio/series/" + series["id"]
    settings = await client.put(
        series_path + "/settings",
        json={
            "revision": series["revision"],
            "requestKey": "settings",
            "assetVersionIds": [version],
        },
    )
    assert settings.status_code == 200, settings.text
    series = settings.json()
    for number in (1, 2):
        response = await client.post(
            series_path + "/episodes",
            json={
                "revision": series["revision"],
                "requestKey": f"ep-{number}",
                "title": f"第{number}集",
            },
        )
        assert response.status_code == 200, response.text
        series = response.json()
    first, second = series["episodes"]
    extra = await client.post(
        "/api/studio/assets", json={"kind": "character", "name": "单集引用角色"}
    )
    assert extra.status_code == 200, extra.text
    imported = await client.post(
        "/api/studio/projects/" + first["projectId"] + "/library-imports",
        json={
            "sourceVersionId": extra.json()["id"],
            "requestKey": "library-import",
            "expectedRevision": first["projectRevision"],
        },
    )
    assert imported.status_code == 200, imported.text
    pending = await client.post(
        series_path + "/proposals",
        json={
            "revision": series["revision"],
            "requestKey": "pending",
            "episodeIds": [first["id"]],
            "instruction": "补充开场",
        },
    )
    assert pending.status_code == 200, pending.text
    series = (await client.get(series_path)).json()
    # 待处理建议导出为证据；不把源账号的 DSH 授权迁移给目标账号。
    locked = await client.post(
        series_path + "/episodes/" + second["id"] + "/lock",
        json={"revision": series["revision"], "requestKey": "lock", "locked": True},
    )
    assert locked.status_code == 200, locked.text
    quick_bundle, series_bundle = tmp_path / "quick", tmp_path / "series"
    await export_work_bundle(
        database, quick_id, "quick", platform_configuration.data_dir, quick_bundle
    )
    await export_work_bundle(
        database, series["id"], "series", platform_configuration.data_dir, series_bundle
    )
    transfer = load_bundle(series_bundle)
    assert len(transfer.rows["studio_series_episodes"]) == 2
    assert len(transfer.rows["studio_library_bindings"]) == 1
    assert transfer.rows["studio_entity_variants"]
    assert transfer.rows["studio_series_proposals"]
    assert transfer.files == []
    async with target_platform(platform_configuration, tmp_path / "target") as (target, remote):
        target_database = target.state.services.studio.database
        await target.state.services.media_jobs.close()
        async with target_database.sessions() as session:
            owner = await session.scalar(text("SELECT id FROM users LIMIT 1"))
        assert owner
        # 原有作品必须保留，导入不会覆盖账号或清空目标库。
        existing = await remote.post("/api/studio/projects", json={"title": "目标原有作品"})
        assert existing.status_code == 200
        for bundle in (quick_bundle, series_bundle):
            dry = await import_bundle(target_database, bundle, tmp_path / "target", owner)
            assert dry["status"] == "dry-run-passed"
        assert (await remote.get("/api/studio/works")).json()["total"] == 1
        await import_bundle(target_database, quick_bundle, tmp_path / "target", owner, apply=True)
        with pytest.raises(ValueError, match="基线不一致"):
            await import_bundle(target_database, series_bundle, tmp_path / "target", owner)
        original_publish = importer.publish_files

        def fail_publish(transfer: Transfer, runtime: Path, created: list[Path]) -> None:
            original_publish(transfer, runtime, created)
            raise RuntimeError("模拟整剧事务失败")

        monkeypatch.setattr(importer, "publish_files", fail_publish)
        with pytest.raises(RuntimeError, match="模拟整剧"):
            await import_bundle(
                target_database,
                series_bundle,
                tmp_path / "target",
                owner,
                apply=True,
                reuse_identical=True,
            )
        assert (await remote.get(series_path)).status_code == 404
        assert (await remote.get(quick_path)).status_code == 200
        monkeypatch.setattr(importer, "publish_files", original_publish)
        result = await import_bundle(
            target_database,
            series_bundle,
            tmp_path / "target",
            owner,
            apply=True,
            reuse_identical=True,
        )
        assert result["status"] == "imported" and result["reusedRows"]
        current = await remote.get(series_path)
        assert current.status_code == 200, current.text
        assert current.json()["episodes"][1]["locked"] is True
        assert [item["id"] for item in current.json()["settings"]] == [version]
        assert (await remote.get(series_path + "/proposals")).json() == []
        works = (await remote.get("/api/studio/works")).json()
        assert works["total"] == 3
        assert {row["kind"] for row in works["items"]} == {"quick", "storyboard", "series"}
        for bundle in (quick_bundle, series_bundle):
            replay = await import_bundle(
                target_database,
                bundle,
                tmp_path / "target",
                owner,
                apply=True,
                reuse_identical=True,
            )
            assert replay["reusedRows"] and replay["newFiles"] == 0
        async with target_database.sessions.begin() as session:
            assert await session.scalar(text("SELECT count(*) FROM users")) == 1
            assert await session.scalar(text("SELECT count(*) FROM studio_media_jobs")) == 0
            await session.execute(
                text("UPDATE studio_series SET title='目标手工修改' WHERE id=:id"),
                {"id": series["id"]},
            )
        with pytest.raises(ValueError, match="基线不一致"):
            await import_bundle(
                target_database,
                series_bundle,
                tmp_path / "target",
                owner,
                apply=True,
                reuse_identical=True,
            )
        assert (await remote.get(series_path)).json()["title"] == "目标手工修改"
