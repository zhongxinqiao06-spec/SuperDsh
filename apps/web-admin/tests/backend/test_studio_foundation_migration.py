"""旧工程真实升级：稳定镜头、配音、裁剪、菜单限制和失败回滚。"""

import json

import pytest
from conftest import upgrade_database
from sqlalchemy import insert, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.identity.entity.do.models import UserRow

pytestmark = pytest.mark.parametrize("platform_configuration", ["f28d6419b037"], indirect=True)


@pytest.mark.parametrize("broken", [False, True], ids=["preserve", "rollback"])
async def test_migrate_legacy_project(platform_configuration: Settings, broken: bool) -> None:
    engine = create_async_engine(platform_configuration.database_url)
    doc = {
        "script": "原剧本",
        "assets": ["role"],
        "shots": [
            {
                "id": "shot",
                "action": "雨夜",
                "scene": "站台",
                "duration": 5000,
                "candidate": "video",
                "trimStart": 500,
                "trimEnd": 4000,
                "references": ["role"],
                "lines": [
                    {
                        "id": "line",
                        "role": "role",
                        "text": "出发",
                        "audio": "speech",
                        "start": 800,
                        "subtitle": "启程",
                        "subtitleStart": 900,
                        "end": 1800,
                        "volume": 0.7,
                    }
                ],
            }
        ],
        "music": None,
        "musicVolume": 0.6,
    }
    items = [
        {
            "id": "studio-workspace",
            "kind": "group",
            "moduleId": None,
            "parentId": None,
            "title": "我的制作组",
            "icon": "folder",
            "order": 0,
            "visible": False,
            "roleIds": ["admin"],
        },
        {
            "id": "studio.projects",
            "kind": "page",
            "moduleId": "studio.projects",
            "parentId": "studio-workspace",
            "title": "我的片单",
            "icon": "folder",
            "order": 0,
            "visible": True,
            "roleIds": [],
        },
        {
            "id": "studio.library",
            "kind": "page",
            "moduleId": "studio.library",
            "parentId": "studio-workspace",
            "title": "素材库",
            "icon": "folder",
            "order": 1,
            "visible": True,
            "roleIds": [],
        },
    ]
    try:
        async with engine.begin() as connection:
            await connection.execute(
                insert(UserRow).values(
                    id="owner",
                    username="owner",
                    password_hash="synthetic",
                    roles=["admin"],
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_projects(id,owner,title,revision) VALUES ('film','owner','历史作品',3)"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO studio_assets(id,family,owner,definition) VALUES ('role','family','owner',CAST(:definition AS jsonb))"
                ),
                {
                    "definition": json.dumps(
                        {
                            "kind": "character",
                            "name": "小林",
                            "voice": "voice-a",
                            "description": "原造型",
                            "fileId": None,
                        }
                    )
                },
            )
            for identifier, kind, subject in (
                ("video", "video", "shot"),
                ("speech", "speech", "line"),
            ):
                await connection.execute(
                    text(
                        "INSERT INTO studio_media_jobs(id,project,request_key,subject,kind,revision,state,payload) VALUES (:id,'film',:id,:subject,:kind,3,'ready',CAST(:payload AS jsonb))"
                    ),
                    {
                        "id": identifier,
                        "subject": subject,
                        "kind": kind,
                        "payload": json.dumps({"duration": 5000 if kind == "video" else 1000}),
                    },
                )
            if not broken:
                await connection.execute(
                    text(
                        "INSERT INTO studio_revisions(project,revision,document,label) VALUES ('film',3,CAST(:doc AS jsonb),'历史')"
                    ),
                    {"doc": json.dumps(doc)},
                )
            await connection.execute(
                text(
                    "INSERT INTO navigation_settings(id,version,items) VALUES ('entertainment',7,CAST(:items AS jsonb)),('global',4,'[]')"
                ),
                {"items": json.dumps(items)},
            )
        if broken:
            with pytest.raises(RuntimeError, match="缺少当前修订"):
                await upgrade_database(platform_configuration.database_url)
            async with engine.connect() as connection:
                assert (
                    await connection.scalar(text("SELECT version_num FROM alembic_version"))
                    == "f28d6419b037"
                )
                assert await connection.scalar(text("SELECT count(*) FROM studio_assets")) == 1
                assert await connection.scalar(text("SELECT to_regclass('studio_scripts')")) is None
            return
        await upgrade_database(platform_configuration.database_url)
        await upgrade_database(platform_configuration.database_url)
        async with engine.connect() as connection:
            assert (
                await connection.scalar(
                    text(
                        "SELECT document FROM studio_revisions WHERE project='film' AND revision=3"
                    )
                )
                == doc
            )
            assert await connection.scalar(text("SELECT count(*) FROM studio_media_jobs")) == 2
            assert (
                await connection.scalar(
                    text(
                        "SELECT speaker_version_id FROM studio_lines WHERE project_id='film' AND id='line'"
                    )
                )
                != "role"
            )
            clips = (
                (
                    await connection.execute(
                        text("SELECT * FROM studio_clips WHERE project_id='film'")
                    )
                )
                .mappings()
                .all()
            )
            by_role = {row["role"]: row for row in clips}
            assert by_role["primary_video"]["job_id"] == "video"
            assert by_role["primary_video"]["source_start_ticks"] == 500 * 48
            assert by_role["primary_video"]["duration_ticks"] == 3500 * 48
            assert by_role["primary_voice"]["job_id"] == "speech"
            assert by_role["primary_voice"]["gain"] == 0.7
            assert by_role["subtitle"]["subtitle_text"] == "启程"
            assert (
                await connection.scalar(
                    text("SELECT music_gain FROM studio_timelines WHERE project_id='film'")
                )
                == 0.6
            )
            menu = await connection.scalar(
                text("SELECT items FROM navigation_settings WHERE id='entertainment'")
            )
            assert (
                next(item for item in menu if item["moduleId"] == "studio.projects")["title"]
                == "我的片单"
            )
            group = next(item for item in menu if item["title"] == "素材中心")
            assert not group["visible"] and group["roleIds"] == ["admin"]
            assert (
                await connection.scalar(
                    text("SELECT version FROM navigation_settings WHERE id='global'")
                )
                == 4
            )
            # PostgreSQL CHECK 会放过 UNKNOWN，必须显式拒绝只填写一边的画幅。
            for width, height in ((None, 16), (9, None), (0, 16)):
                with pytest.raises(IntegrityError, match="ck_studio_project_aspect"):
                    async with connection.begin_nested():
                        await connection.execute(
                            text(
                                "UPDATE studio_projects SET aspect_width=:width, "
                                "aspect_height=:height WHERE id='film'"
                            ),
                            {"width": width, "height": height},
                        )
    finally:
        await engine.dispose()
