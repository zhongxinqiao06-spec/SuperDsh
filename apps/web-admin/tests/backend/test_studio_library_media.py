"""库素材进入场次、镜头与导出的真实闭环；不调用付费供应商。"""

import asyncio
import struct
import wave
from collections.abc import AsyncIterator
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from pydantic import ValidationError

from app.infrastructure.errors import DomainError
from app.modules.studio.entity.bo.preparation_state import preparation_inputs
from app.modules.studio.entity.do.models import StudioAsset
from app.modules.studio.entity.vo.production_vo import ProductionIntent
from app.modules.studio.entity.vo.studio_vo import Batch, Document, SaveDocument
from app.modules.studio.service.generation_inputs import GenerationInputs
from app.modules.studio.service.media_source_service import media_duration
from app.modules.studio.service.studio_service import validate_document
from app.modules.studio.service.timeline_renderer import TimelineRenderer


def test_media_source_contract_and_kind_boundaries() -> None:
    """不能把同一位置同时绑定任务与库文件，也不能借图片ID当成视频。"""
    with pytest.raises(ValidationError):
        Document.model_validate(
            {"shots": [{"action": "test", "candidate": "job", "videoAssetId": "video"}]}
        )
    with pytest.raises(ValidationError):
        Document.model_validate(
            {
                "shots": [
                    {
                        "action": "test",
                        "lines": [
                            {
                                "role": "role",
                                "text": "hi",
                                "audio": "job",
                                "audioAssetId": "audio",
                            }
                        ],
                    }
                ]
            }
        )
    document = Document.model_validate(
        {"assets": ["image"], "shots": [{"action": "test", "videoAssetId": "image"}]}
    )
    with pytest.raises(DomainError, match="对应素材"):
        validate_document(
            document,
            [StudioAsset(id="image", definition={"kind": "image", "fileId": "file"})],
            [],
        )


def test_new_optional_bindings_do_not_invalidate_old_stage_confirmations() -> None:
    """升级只补空字段时保持原确认指纹，真正选场景或库视频后才改变依赖。"""
    current = Document.model_validate(
        {
            "script": "剧本",
            "scenes": [{"id": "scene", "title": "场次"}],
            "shots": [
                {
                    "id": "shot",
                    "sceneId": "scene",
                    "action": "出发",
                    "candidate": "video-job",
                }
            ],
        }
    ).model_dump()
    legacy = deepcopy(current)
    legacy.pop("soundEffects")
    for scene in legacy["scenes"]:
        scene.pop("sceneAssetId")
    for shot in legacy["shots"]:
        shot.pop("sceneAssetId")
        shot.pop("videoAssetId")
    assert preparation_inputs(current, [], [], {}) == preparation_inputs(legacy, [], [], {})
    current["shots"][0]["videoAssetId"] = "library-video"
    current["shots"][0]["candidate"] = None
    assert (
        preparation_inputs(current, [], [], {})["sample"]
        != preparation_inputs(legacy, [], [], {})["sample"]
    )


async def test_scene_and_prop_are_actual_generation_inputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inputs = GenerationInputs.__new__(GenerationInputs)
    inputs.media = MagicMock()
    images = AsyncMock(return_value=["battery-image", "forest-image"])
    monkeypatch.setattr(inputs, "images", images)
    monkeypatch.setattr(
        inputs,
        "model",
        AsyncMock(
            return_value=(
                {
                    "configurationId": "video",
                    "revision": 1,
                    "capability": "video.generate",
                },
                {
                    "connection": {
                        "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
                    },
                    "apiKey": "synthetic",
                    "configuration": {"modelId": "fixture", "name": "受控模型"},
                },
            )
        ),
    )
    shot = Document.model_validate(
        {"shots": [{"action": "举起电池", "references": ["prop"], "sceneAssetId": "scene"}]}
    ).model_dump()["shots"][0]
    result = await inputs.video(
        shot,
        {
            "prop": {
                "kind": "prop",
                "name": "星星电池",
                "description": "金色五角星",
                "fileId": "battery-image",
            },
            "scene": {
                "kind": "scene",
                "name": "森林雨夜",
                "description": "蓝色树木与雨水",
                "fileId": "forest-image",
            },
        },
        {},
        {},
    )
    assert "星星电池：金色五角星" in result["prompt"]
    assert "森林雨夜：蓝色树木与雨水" in result["prompt"]
    assert "沿用环境布局" in result["prompt"]
    images.assert_awaited_once_with(["battery-image", "forest-image"], 9, minimum_side=300)


async def test_media_asset_stream_renders_and_checks_actual_duration(
    tmp_path: Path,
) -> None:
    renderer = TimelineRenderer(tmp_path)
    await renderer.command(
        tmp_path,
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x180:r=25",
            "-t",
            "1",
            "-c:v",
            "libx264",
            "input.mp4",
        ],
    )
    duration = await media_duration(tmp_path / "input.mp4")
    assert 950 <= duration <= 1050

    async def chunks() -> AsyncIterator[bytes]:
        data = (tmp_path / "input.mp4").read_bytes()
        for offset in range(0, len(data), 256):
            yield data[offset : offset + 256]

    document = Document.model_validate(
        {
            "assets": ["video"],
            "shots": [
                {
                    "action": "素材剪辑",
                    "videoAssetId": "video",
                    "duration": 1000,
                    "trimStart": 200,
                    "trimEnd": 900,
                }
            ],
        }
    )
    await renderer.render(document, tmp_path / "output.mp4", media={"video": chunks()})
    assert 650 <= await media_duration(tmp_path / "output.mp4") <= 800
    await renderer.command(tmp_path, ["-i", str(tmp_path / "output.mp4"), "-f", "null", "-"])
    assert not await asyncio.to_thread(lambda: any(p.is_dir() for p in tmp_path.iterdir())), (
        "渲染临时目录必须释放"
    )


async def test_scene_and_media_save_restore_export(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """采用个人库文件可真实导出，继承场景与镜头覆盖可保存回读，错类型不能写入。"""
    app, client = platform
    auth = await bootstrap(client)
    services = app.state.services
    account = await services.identity.authenticate(auth["accessToken"])
    media = services.media_jobs
    await media.close()
    media.root.mkdir(parents=True, exist_ok=True)
    await media.renderer.command(
        media.root,
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=green:s=320x180:r=25",
            "-t",
            "2",
            "-c:v",
            "libx264",
            "library.mp4",
        ],
    )
    await media.renderer.command(
        media.root,
        [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=24000",
            "-t",
            "0.4",
            "voice.wav",
        ],
    )
    video = await services.files.ingest_media(
        account, "library-video", media.root / "library.mp4", "video/mp4"
    )
    voice = await services.files.ingest_media(
        account, "library-voice", media.root / "voice.wav", "audio/wav"
    )

    async def asset(kind: str, name: str, file_id: str | None = None) -> str:
        response = await client.post(
            "/api/studio/assets", json={"kind": kind, "name": name, "fileId": file_id}
        )
        assert response.status_code == 200, response.text
        return response.json()["id"]

    scene = await asset("scene", "森林日景")
    night = await asset("scene", "森林夜景")
    hero = await asset("character", "小白")
    video_id = await asset("video", "视频复用", str(video["id"]))
    audio_id = await asset("audio", "配音复用", str(voice["id"]))
    metadata = await client.get(f"/api/studio/assets/{audio_id}/metadata")
    assert metadata.status_code == 200, metadata.text
    assert 350 <= metadata.json()["durationMs"] <= 450
    project = (await client.post("/api/studio/projects", json={"title": "库素材复用测试"})).json()[
        "id"
    ]
    uri = f"/api/studio/projects/{project}"
    document = {
        "assets": [scene, night, hero, video_id, audio_id],
        "scenes": [{"id": "story", "title": "森林探险", "sceneAssetId": scene}],
        "soundEffects": [
            {
                "id": "effect",
                "assetId": audio_id,
                "shotId": "shot",
                "start": 500,
                "volume": 0.8,
            }
        ],
        "shots": [
            {
                "id": "shot",
                "action": "走进森林",
                "sceneId": "story",
                "sceneAssetId": night,
                "videoAssetId": video_id,
                "duration": 1000,
                "lines": [
                    {
                        "id": "line",
                        "role": hero,
                        "text": "出发",
                        "audioAssetId": audio_id,
                    }
                ],
            }
        ],
    }
    saved = await client.put(
        uri, json={"revision": 1, "document": document, "requestKey": "save-media"}
    )
    assert saved.status_code == 200, saved.text
    opened = (await client.get(uri)).json()
    current = opened["document"]
    assert current["scenes"][0]["sceneAssetId"] != scene, "本片设定应独立派生"
    assert current["shots"][0]["sceneAssetId"] != night
    assert current["shots"][0]["videoAssetId"] == video_id
    assert current["shots"][0]["lines"][0]["audioAssetId"] == audio_id
    assert current["soundEffects"][0]["assetId"] == audio_id
    assert current["soundEffects"][0]["shotId"] == "shot"
    summaries = (await client.get("/api/studio/projects", params={"page": 1})).json()
    summary = next(row for row in summaries["items"] if row["id"] == project)
    assert summary["adopted"] == 1 and summary["coverAssetId"] == video_id
    assert summary["coverJobId"] is None
    wrong = deepcopy(current)
    wrong["shots"][0]["videoAssetId"] = current["scenes"][0]["sceneAssetId"]
    assert (await client.put(uri, json={"revision": 2, "document": wrong})).status_code == 422
    export = await client.post(
        uri + "/jobs",
        json={"revision": 2, "requestKey": "export-library", "export": True},
    )
    assert export.status_code == 200, export.text
    from app.modules.studio.dao.production_dao import ProductionDao

    async with services.studio.database.sessions() as session:
        job = await ProductionDao(session).job(export.json()[0]["id"])
    assert job is not None
    assert job.payload["mediaFiles"] == {video_id: video["id"], audio_id: voice["id"]}
    await media.process(job)
    ready = next(j for j in (await client.get(uri)).json()["jobs"] if j["id"] == job.id)
    assert ready["state"] == "ready", ready
    assert 950 <= await media_duration(media.path(job)) <= 1100
    await media.renderer.command(
        media.root,
        [
            "-i",
            str(media.path(job)),
            "-vn",
            "-ar",
            "8000",
            "-ac",
            "1",
            "soundtrack.wav",
        ],
    )
    with wave.open(str(media.root / "soundtrack.wav"), "rb") as audio:
        audio.setpos(4800)
        samples = struct.unpack("<" + "h" * 400, audio.readframes(400))
    assert max(abs(value) for value in samples) > 100, "镜头音效须进入实际导出，不能只保存字段"
    # 工程变化后重试同一导出仍返回原收据，既不重计费用也不丢冻结版本。
    current["shots"][0]["sceneAssetId"] = None
    assert (await client.put(uri, json={"revision": 2, "document": current})).status_code == 200
    replay = await client.post(
        uri + "/jobs",
        json={"revision": 2, "requestKey": "export-library", "export": True},
    )
    assert replay.json()[0]["id"] == job.id
    # 文件复用不需要模型调用权限；同一账号的文件权限和跨账号边界仍生效。
    limited = replace(
        account,
        permissions=tuple(item for item in account.permissions if item != "models.use"),
    )
    assert (await media.sources.metadata(limited, video_id))["durationMs"] >= 1950
    with pytest.raises(DomainError) as forbidden_model:
        await media.production.inspect(
            limited,
            project,
            ProductionIntent(revision=3, requestKey="forbidden-generation", mode="missing"),
        )
    assert forbidden_model.value.status == 403
    with pytest.raises(DomainError) as forbidden_file:
        await media.sources.metadata(
            replace(
                limited,
                permissions=tuple(item for item in limited.permissions if item != "files.read"),
            ),
            video_id,
        )
    assert forbidden_file.value.status == 403
    with pytest.raises(DomainError) as other_owner:
        await media.sources.metadata(replace(limited, user_id="someone-else"), video_id)
    assert other_owner.value.status == 404
    other_project = (
        await client.post("/api/studio/projects", json={"title": "另一本人作品"})
    ).json()["id"]
    private_video_response = await client.post(
        "/api/studio/assets",
        json={
            "kind": "video",
            "name": "仅另一作品引用",
            "project": other_project,
            "fileId": video["id"],
        },
    )
    assert private_video_response.status_code == 200, private_video_response.text
    private_video = private_video_response.json()["id"]
    with pytest.raises(DomainError) as wrong_project:
        await media.sources.metadata(limited, private_video, project)
    assert wrong_project.value.status == 404
    wrong_scope = deepcopy(current)
    wrong_scope["assets"].append(private_video)
    wrong_scope["shots"][0]["videoAssetId"] = private_video
    with pytest.raises(DomainError) as scope_write:
        await services.studio.save(
            limited,
            project,
            SaveDocument(revision=3, document=Document.model_validate(wrong_scope)),
        )
    assert scope_write.value.status == 422
    exported = await media.submit(
        limited, project, Batch(revision=3, requestKey="without-models", export=True)
    )
    assert len(exported) == 1
    too_long = deepcopy(current)
    too_long["shots"][0]["duration"] = 5000
    with pytest.raises(DomainError, match="视频长度"):
        await services.studio.save(
            limited,
            project,
            SaveDocument(revision=3, document=Document.model_validate(too_long)),
        )
