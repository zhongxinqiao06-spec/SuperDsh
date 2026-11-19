"""从已部署素材库迁移升级三种创作模式，旧账号、作品与快照逐字段保留。"""

import pytest
from conftest import upgrade_database
from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.identity.entity.do.models import UserRow


@pytest.mark.parametrize("platform_configuration", ["00a2e93fb844"], indirect=True)
@pytest.mark.parametrize("missing_column", [True, False])
async def test_prompt_repair_preserves_deployed_series(
    platform_configuration: Settings, missing_column: bool
) -> None:
    """复现已记账但缺列的旧库，并验证已有冻结指令不会被升级重置。"""
    engine = create_async_engine(platform_configuration.database_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                insert(UserRow).values(
                    id="prompt-owner",
                    username="prompt-owner",
                    password_hash="unchanged-hash",
                    roles=["admin"],
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_projects (id, owner, title, revision) "
                    "VALUES ('prompt-project', 'prompt-owner', '保留工程', 7)"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_series (id, owner, title, creation_key, creation_hash) "
                    "VALUES ('prompt-series', 'prompt-owner', '保留整剧', 'key', 'hash')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_series_proposals "
                    "(id, series_id, project_id, base_revision, original, instruction, prompt_text) "
                    "VALUES ('prompt-draft', 'prompt-series', 'prompt-project', 1, '[]', "
                    "'用户安排', '已冻结的完整上下文')"
                )
            )
            if missing_column:
                await connection.execute(
                    text("ALTER TABLE studio_series_proposals DROP COLUMN prompt_text")
                )
            before = await connection.scalar(
                text("SELECT to_jsonb(p) - 'prompt_text' FROM studio_series_proposals p")
            )
        await upgrade_database(platform_configuration.database_url)
        await upgrade_database(platform_configuration.database_url)
        async with engine.connect() as connection:
            after = await connection.scalar(
                text("SELECT to_jsonb(p) FROM studio_series_proposals p")
            )
            assert after.pop("prompt_text") == ("" if missing_column else "已冻结的完整上下文")
            assert after == before
            assert (
                await connection.scalar(
                    text("SELECT revision FROM studio_projects WHERE id='prompt-project'")
                )
                == 7
            )
            assert (
                await connection.scalar(
                    text("SELECT password_hash FROM users WHERE id='prompt-owner'")
                )
                == "unchanged-hash"
            )
    finally:
        await engine.dispose()


@pytest.mark.parametrize("platform_configuration", ["00895f4a6c12"], indirect=True)
async def test_series_upgrade_preserves_existing_projects(platform_configuration: Settings) -> None:
    engine = create_async_engine(platform_configuration.database_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                insert(UserRow).values(
                    id="old-owner",
                    username="old-owner",
                    password_hash="unchanged-synthetic-hash",
                    roles=["admin"],
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_projects (id, owner, title, revision, brief) VALUES ('existing-film', 'old-owner', '既有作品', 7, '保留原构想')"
                )
            )
            await connection.execute(
                text(
                    'INSERT INTO studio_revisions (project, revision, document, label) VALUES (\'existing-film\', 7, \'{"script":"保留原稿","assets":[],"shots":[]}\'::jsonb, \'历史版本\')'
                )
            )
            before = await connection.scalar(
                text("SELECT to_jsonb(p) FROM studio_projects p WHERE id='existing-film'")
            )
            snapshot = await connection.scalar(
                text(
                    "SELECT document FROM studio_revisions WHERE project='existing-film' AND revision=7"
                )
            )
        await upgrade_database(platform_configuration.database_url)
        async with engine.connect() as connection:
            after = await connection.scalar(
                text("SELECT to_jsonb(p) FROM studio_projects p WHERE id='existing-film'")
            )
            assert {
                key: value
                for key, value in after.items()
                if key not in {"creation_mode", "quick_draft"}
            } == before
            assert after["creation_mode"] == "storyboard"
            assert (
                await connection.scalar(
                    text(
                        "SELECT document FROM studio_revisions WHERE project='existing-film' AND revision=7"
                    )
                )
                == snapshot
            )
            assert (
                await connection.scalar(
                    text("SELECT password_hash FROM users WHERE id='old-owner'")
                )
                == "unchanged-synthetic-hash"
            )
            assert await connection.scalar(text("SELECT count(*) FROM studio_series")) == 0
            assert await connection.scalar(text("SELECT count(*) FROM studio_series_episodes")) == 0
            columns = set(
                await connection.scalars(
                    text(
                        "SELECT column_name FROM information_schema.columns WHERE table_name='studio_series_proposals'"
                    )
                )
            )
            assert {"prompt_text", "original", "suggestions", "project_id", "state"} <= columns
    finally:
        await engine.dispose()


@pytest.mark.parametrize("platform_configuration", ["00a1d82fa733"], indirect=True)
async def test_structure_upgrade_preserves_executed_series_schema(
    platform_configuration: Settings,
) -> None:
    """结构操作通过追加迁移升级；已经建立的集序、锁和项目归属保持原样。"""
    engine = create_async_engine(platform_configuration.database_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                insert(UserRow).values(
                    id="series-owner",
                    username="series-owner",
                    password_hash="synthetic-series-hash",
                    roles=["admin"],
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_projects (id, owner, title, revision) VALUES ('episode-project', 'series-owner', '既有分集', 3)"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_series (id, owner, title, creation_key, creation_hash) VALUES ('existing-series', 'series-owner', '既有整剧', 'existing-key', 'existing-hash')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_series_setting_versions (series_id, revision, asset_version_ids) VALUES ('existing-series', 1, '[]'::jsonb)"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_series_episodes (id, series_id, owner, project_id, position, title, story, settings_revision, target_duration_ms, locked) VALUES ('existing-episode', 'existing-series', 'series-owner', 'episode-project', 1, '既有分集', '{}'::jsonb, 1, 45000, true)"
                )
            )
            before = await connection.scalar(
                text("SELECT to_jsonb(e) FROM studio_series_episodes e WHERE id='existing-episode'")
            )
        await upgrade_database(platform_configuration.database_url)
        async with engine.connect() as connection:
            after = await connection.scalar(
                text("SELECT to_jsonb(e) FROM studio_series_episodes e WHERE id='existing-episode'")
            )
            assert {
                key: value
                for key, value in after.items()
                if key not in {"archived", "archived_at", "archive_reason"}
            } == before
            assert after["archived"] is False and after["archived_at"] is None
            assert (
                await connection.scalar(text("SELECT count(*) FROM studio_series_structure_plans"))
                == 0
            )
    finally:
        await engine.dispose()
