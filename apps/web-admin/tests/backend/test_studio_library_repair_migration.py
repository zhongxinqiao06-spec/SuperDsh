"""已记账的早期素材库结构补迁移，保留旧作品并修复试听与参考图投影。"""

from datetime import UTC, datetime

import pytest
from conftest import upgrade_database
from sqlalchemy import delete, insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncConnection, async_sessionmaker, create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.files.entity.do.models import FileEntryRow
from app.modules.identity.entity.do.models import UserRow
from app.modules.studio.dao.library_dao import LibraryDao
from app.modules.studio.entity.do.asset_do import (
    AssetFamily,
    AssetVersion,
    EntityVariant,
    EntityVersion,
    EntityVersionAsset,
    StudioEntity,
)
from app.modules.studio.entity.do.library_do import LibraryBinding
from app.modules.studio.entity.do.models import StudioAsset, StudioProject, StudioRevision
from app.modules.studio.entity.do.timeline_do import StudioClip, StudioTimeline, StudioTrack
from migrations.data.studio_foundation_data import ASSET_VIEW

pytestmark = pytest.mark.parametrize("platform_configuration", ["00673d284af0"], indirect=True)

REPAIRED_COLUMNS = {
    "studio_asset_versions": ("duration_ms", "width", "height"),
    "studio_clips": ("effect_id",),
    "studio_library_bindings": ("field_versions", "project_variant_id"),
}
PRESERVED_TABLES = (
    "users",
    "studio_projects",
    "studio_revisions",
    "studio_entities",
    "studio_entity_versions",
    "studio_entity_variants",
    "studio_asset_families",
    "studio_asset_versions",
    "studio_entity_version_assets",
    "studio_library_bindings",
    "studio_timelines",
    "studio_clips",
    "web_file_entries",
)


async def library_snapshot(connection: AsyncConnection, missing: bool) -> dict[str, list[dict]]:
    """比较所有既有行，早期缺失列不纳入旧数据快照，标识与数量同时受到保护。"""
    result = {}
    for table in PRESERVED_TABLES:
        rows = await connection.scalars(
            text(f"SELECT to_jsonb(record) FROM {table} AS record ORDER BY to_jsonb(record)::text")
        )
        result[table] = [
            {
                key: value
                for key, value in row.items()
                if not missing or key not in REPAIRED_COLUMNS.get(table, ())
            }
            for row in rows
        ]
    return result


async def seed_library(connection: AsyncConnection) -> None:
    """只在 fixture 创建的合成数据库写入有来源、试听和剪辑的历史作品。"""
    await connection.execute(
        insert(UserRow).values(
            id="owner", username="owner", password_hash="synthetic-hash", roles=["admin"]
        )
    )
    await connection.execute(
        insert(StudioProject).values(id="film", owner="owner", title="历史作品", revision=7)
    )
    await connection.execute(
        insert(StudioRevision).values(
            project="film",
            revision=7,
            document={"script": "保留原剧本", "assets": ["local-role"], "shots": []},
            label="历史修订",
        )
    )
    for family, version, project, origin in (
        ("library-family", "library-role", None, None),
        ("project-family", "local-role", "film", "library-role"),
    ):
        await connection.execute(
            insert(StudioEntity).values(
                id=family,
                owner_id="owner",
                project_id=project,
                kind="character",
                name="历史角色",
                current_version_id=version,
            )
        )
        await connection.execute(
            insert(EntityVersion).values(
                id=version,
                entity_id=family,
                version_no=1,
                origin_version_id=origin,
                name="历史角色",
                description="保留角色设定",
                voice_id="original-voice",
            )
        )
        await connection.execute(
            insert(EntityVariant).values(
                id=f"{family}-variant",
                entity_id=family,
                name="原造型",
                current_version_id=version,
            )
        )
        await connection.execute(
            update(EntityVersion)
            .where(EntityVersion.id == version)
            .values(variant_id=f"{family}-variant")
        )
    for name, kind, purpose, position in (
        ("preview", "audio", "voice-preview", 0),
        ("reference", "image", "reference", 1),
    ):
        await connection.execute(
            insert(FileEntryRow).values(
                id=f"{name}-file",
                owner_id="owner",
                storage_id="synthetic-storage",
                object_key=f"synthetic/{name}",
                name=name,
                size=1,
                sha256="0" * 64,
                media_type="audio/wav" if kind == "audio" else "image/png",
                category=kind,
                created_at=datetime.now(UTC),
            )
        )
        await connection.execute(
            insert(AssetFamily).values(
                id=f"{name}-family",
                owner_id="owner",
                kind=kind,
                name=name,
                current_version_id=f"{name}-version",
            )
        )
        await connection.execute(
            insert(AssetVersion).values(
                id=f"{name}-version",
                family_id=f"{name}-family",
                version_no=1,
                file_id=f"{name}-file",
                name=name,
                duration_ms=1200 if kind == "audio" else None,
                width=320 if kind == "image" else None,
                height=240 if kind == "image" else None,
            )
        )
        await connection.execute(
            insert(EntityVersionAsset).values(
                entity_version_id="library-role",
                asset_version_id=f"{name}-version",
                purpose=purpose,
                position=position,
            )
        )
    await connection.execute(
        insert(LibraryBinding).values(
            project_id="film",
            project_family_id="project-family",
            project_variant_id="project-family-variant",
            owner_id="owner",
            library_family_id="library-family",
            imported_version_id="library-role",
            project_version_id="local-role",
            field_versions={"description": "library-role"},
            revision=3,
        )
    )
    await connection.execute(
        insert(StudioTimeline).values(
            project_id="film",
            ticks_per_second=48000,
            fps_num=24,
            fps_den=1,
            audio_sample_rate=48000,
            music_gain=0.7,
        )
    )
    await connection.execute(
        insert(StudioTrack).values(project_id="film", id="subtitle", kind="subtitle", position=3)
    )
    await connection.execute(
        insert(StudioClip).values(
            project_id="film",
            id="original-clip",
            track_id="subtitle",
            role="subtitle",
            effect_id="original-effect",
            start_ticks=4800,
            duration_ticks=48000,
            subtitle_text="原字幕",
            gain=0.8,
        )
    )


@pytest.mark.parametrize("missing", [True, False], ids=["early-schema", "complete-schema"])
async def test_repair_recorded_library_migrations(
    platform_configuration: Settings, missing: bool
) -> None:
    url = platform_configuration.database_url
    engine = create_async_engine(url)
    try:
        async with engine.begin() as connection:
            await seed_library(connection)
            if missing:
                # 旧 revision 已记账，后续修改旧迁移文件不会重放；只模拟已知的早期结构。
                await connection.execute(
                    text(
                        "ALTER TABLE studio_library_bindings DROP CONSTRAINT studio_library_bindings_pkey"
                    )
                )
                for table, columns in REPAIRED_COLUMNS.items():
                    for column in columns:
                        await connection.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
                await connection.execute(
                    text(
                        "ALTER TABLE studio_library_bindings ADD PRIMARY KEY (project_id, project_family_id)"
                    )
                )
                await connection.execute(
                    text(ASSET_VIEW.replace("CREATE VIEW", "CREATE OR REPLACE VIEW", 1))
                )
                definition = await connection.scalar(
                    text("SELECT definition FROM studio_assets WHERE id='library-role'")
                )
                assert definition["fileId"] == "preview-file"
                assert "voicePreviewAssetId" not in definition
            else:
                await connection.execute(
                    insert(StudioTrack).values(
                        project_id="film", id="sound", kind="sound", position=4
                    )
                )
            assert (
                await connection.scalar(text("SELECT version_num FROM alembic_version"))
                == "00673d284af0"
            )
            before = await library_snapshot(connection, missing)

        await upgrade_database(url)
        await upgrade_database(url)
        async with engine.connect() as connection:
            assert await library_snapshot(connection, missing) == before
            assert (
                await connection.scalar(text("SELECT version_num FROM alembic_version"))
                == "00895f4a6c12"
            )
            assert (
                await connection.scalar(
                    text("SELECT project_variant_id FROM studio_library_bindings")
                )
                == "project-family-variant"
            )
            assert (
                await connection.scalar(
                    text(
                        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='studio_library_bindings'::regclass AND contype='p'"
                    )
                )
                == "PRIMARY KEY (project_id, project_family_id, project_variant_id)"
            )
            assert (
                await connection.scalar(
                    text(
                        "SELECT count(*) FROM studio_tracks WHERE project_id='film' AND id='sound' AND kind='sound' AND position=4"
                    )
                )
                == 1
            )
            assert (
                await connection.scalar(
                    text("SELECT count(*) FROM studio_tracks WHERE project_id='film'")
                )
                == 2
            )
            definition = await connection.scalar(
                text("SELECT definition FROM studio_assets WHERE id='library-role'")
            )
            assert definition["fileId"] == "reference-file"
            assert definition["voicePreviewAssetId"] == "preview-version"
            if missing:
                assert (
                    await connection.scalar(
                        text("SELECT field_versions FROM studio_library_bindings")
                    )
                    == {}
                )
                assert await connection.scalar(text("SELECT effect_id FROM studio_clips")) is None
                assert (
                    await connection.scalar(
                        text(
                            "SELECT count(*) FROM studio_asset_versions WHERE duration_ms IS NOT NULL OR width IS NOT NULL OR height IS NOT NULL"
                        )
                    )
                    == 0
                )
        async with async_sessionmaker(engine)() as session:
            local = await session.scalar(select(StudioAsset).where(StudioAsset.id == "local-role"))
            assert local is not None
            metadata = await LibraryDao(session).metadata("owner", [local])
            assert metadata["local-role"]["origin"]["versionId"] == "library-role"
            # 无显式绑定的更早作品仍走递归来源查询；只在本次未提交事务中移除合成绑定。
            await session.execute(delete(LibraryBinding).where(LibraryBinding.project_id == "film"))
            legacy = await LibraryDao(session).metadata("owner", [local])
            assert legacy["local-role"]["origin"]["versionId"] == "library-role"
    finally:
        await engine.dispose()
