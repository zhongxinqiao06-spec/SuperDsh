"""真实数据库与 FFmpeg 的整片回归。受控供应商记录每次提交和查询。"""

import asyncio
import io
import wave
from pathlib import Path

import httpx
import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.studio.entity.do.models import MediaJob


@pytest.fixture
def platform_settings(tmp_path: Path) -> dict[str, object]:
    import json

    config = tmp_path / "model-defaults.json"
    config.write_text(
        json.dumps(
            {
                "connections": [
                    {
                        "id": "fixture",
                        "name": "受控百炼",
                        "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
                        "adapter": "openai-completions",
                        "enabled": True,
                        "apiKey": "synthetic",
                    }
                ],
                "configurations": [
                    {
                        "id": kind,
                        "capability": cap,
                        "connectionId": "fixture",
                        "name": kind,
                        "modelId": kind,
                        "enabled": True,
                        "roleIds": [],
                        "parameters": params,
                    }
                    for kind, cap, params in [
                        ("video", "video.generate", {}),
                        ("reference", "video.generate", {"inputMode": "reference"}),
                        ("tts", "speech.synthesize", {"voices": "a,b"}),
                    ]
                ],
                "defaults": {"video.generate": "video", "speech.synthesize": "tts"},
            }
        )
    )
    return {"model_defaults_file": config}


async def test_batch_resume_adopt_export(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    login = await bootstrap(client)
    services = app.state.services
    jobs = services.media_jobs
    await jobs.close()
    jobs.root.mkdir(parents=True, exist_ok=True)
    await jobs.renderer.command(
        jobs.root,
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x180:r=25",
            "-t",
            "5",
            "-c:v",
            "libx264",
            "sample.mp4",
        ],
    )
    video = (jobs.root / "sample.mp4").read_bytes()
    sound = io.BytesIO()
    with wave.open(sound, "wb") as wav:
        wav.setparams((1, 2, 22050, 0, "NONE", ""))
        wav.writeframes(b"\x00\x01" * 22050)
    posts: list[str] = []
    speech_active = 0
    speech_peak = 0

    async def provider(req: httpx.Request) -> httpx.Response:
        nonlocal speech_active, speech_peak
        if req.method == "POST":
            posts.append(req.url.path)
            if "video-generation" not in req.url.path:
                speech_active += 1
                speech_peak = max(speech_peak, speech_active)
                try:
                    await asyncio.sleep(0.03)
                finally:
                    speech_active -= 1
            return httpx.Response(
                200,
                json={"output": {"task_id": "test-task"}}
                if "video-generation" in req.url.path
                else {"output": {"audio": {"url": "https://files.invalid/line.wav"}}},
            )
        if "/tasks/" in req.url.path:
            return httpx.Response(
                200,
                json={
                    "output": {
                        "task_status": "SUCCEEDED",
                        "video_url": "https://files.invalid/shot.mp4",
                    }
                },
            )
        return httpx.Response(
            200, content=video if req.url.path.endswith(".mp4") else sound.getvalue()
        )

    services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(provider)
    )
    p = (
        await client.post(
            "/api/studio/projects",
            json={"title": "四镜双角色", "aspectWidth": 9, "aspectHeight": 16},
        )
    ).json()["id"]
    uri = f"/api/studio/projects/{p}"
    roles = [
        (
            await client.post(
                "/api/studio/assets",
                json={"name": k, "kind": "character", "voice": k, "project": p},
            )
        ).json()["id"]
        for k in ["a", "b"]
    ]
    account = await services.identity.authenticate(login["accessToken"])
    await jobs.renderer.command(
        jobs.root, ["-i", "sample.mp4", "-vf", "scale=800:450", "-frames:v", "1", "frame.jpg"]
    )
    reference = await services.files.ingest(
        account, "雨夜.jpg", (jobs.root / "frame.jpg").read_bytes(), "image/jpeg"
    )
    scene = (
        await client.post(
            "/api/studio/assets",
            json={"name": "雨夜站台", "kind": "scene", "project": p, "fileId": reference["id"]},
        )
    ).json()["id"]
    doc = {
        "assets": [*roles, scene],
        "shots": [
            {
                "id": f"s{i}",
                "action": "走向车站",
                "references": [scene] if i == 2 else [],
                "lines": [{"id": f"l{i}", "role": roles[i % 2], "text": "出发"}],
            }
            for i in range(4)
        ],
    }
    assert (await client.put(uri, json={"revision": 1, "document": doc})).status_code == 200
    batch = {
        "revision": 2,
        "requestKey": "approved",
        "shots": [f"s{i}" for i in range(4)],
        "lines": [f"l{i}" for i in range(4)],
    }
    first, again = await asyncio.gather(*(client.post(uri + "/jobs", json=batch) for _ in range(2)))
    assert first.status_code == again.status_code == 200
    assert {j["id"] for j in first.json()} == {j["id"] for j in again.json()}

    async def run_stage() -> None:
        async with jobs.database.sessions() as session:
            waiting = list(
                await session.scalars(
                    select(MediaJob).where(MediaJob.state.in_(["queued", "polling", "downloading"]))
                )
            )
        await asyncio.gather(*(jobs.process(job) for job in waiting))

    await run_stage()
    assert len(posts) == 8
    assert speech_peak == 1
    assert {j["state"] for j in (await client.get(uri)).json()["jobs"]} == {
        "polling",
        "downloading",
    }
    # 新会话重新读取数据库中供应商回执，等待生成不用再次 POST。
    await run_stage()
    project = (await client.get(uri)).json()
    assert all(j["state"] == "ready" for j in project["jobs"]) and len(posts) == 8
    assert all(s["candidate"] is None for s in project["document"]["shots"])
    by_subject = {j["subject"]: j for j in project["jobs"]}
    assert by_subject["s2"]["binding"]["configurationId"] == "reference"
    assert by_subject["s0"]["binding"]["configurationId"] == "video"
    # 使用已生成的音频素材做测试配乐，同时覆盖文件引用、流式读取与导出混音。
    background = await client.post(
        uri + "/media/" + by_subject["l0"]["id"] + "/collect", json={"title": "背景声"}
    )
    assert background.status_code == 200, background.text
    background_id = background.json()["id"]
    project["document"]["assets"].append(background_id)
    project["document"].update(music=background_id, musicVolume=0.2)
    for s in project["document"]["shots"]:
        s["candidate"] = by_subject[s["id"]]["id"]
        for line in s["lines"]:
            line["audio"] = by_subject[line["id"]]["id"]
    project["document"]["shots"][0]["trimEnd"] = 3000
    project["document"]["shots"][0]["lines"][0].update(
        subtitle="独立校正字幕", subtitleStart=400, end=1800
    )
    assert (
        await client.put(uri, json={"revision": 2, "document": project["document"]})
    ).status_code == 200
    export = (
        await client.post(
            uri + "/jobs", json={"revision": 3, "requestKey": "export", "export": True}
        )
    ).json()[0]
    project["document"]["shots"].reverse()
    assert (
        await client.put(uri, json={"revision": 3, "document": project["document"]})
    ).status_code == 200
    # 导出提交后改变作品规格，任务仍要使用提交时的竖屏画布。
    assert (
        await client.patch(
            uri,
            json={
                "revision": 4,
                "requestKey": "change-canvas-after-export",
                "title": "四镜双角色",
                "aspectWidth": 16,
                "aspectHeight": 9,
            },
        )
    ).status_code == 200
    await run_stage()
    result = next(j for j in (await client.get(uri)).json()["jobs"] if j["id"] == export["id"])
    assert result["revision"] == 3
    assert result["state"] == "ready", result["error"]
    await jobs.renderer.command(
        jobs.root,
        ["-i", result["id"] + ".mp4", "-frames:v", "1", "frozen-export.png"],
    )
    with Image.open(jobs.root / "frozen-export.png") as frame:
        assert frame.size == (720, 1280)
    media = uri + "/media/" + result["id"]
    assert (await client.post(media + "/access")).status_code == 200
    preview = await client.get(media, headers={"Range": "bytes=0-31"})
    assert (
        preview.status_code == 206
        and len(preview.content) == 32
        and preview.content[4:8] == b"ftyp"
    )

    # 杀进程时若 POST 已送出但还没有可查回执，恢复时不能重发。
    async with jobs.database.sessions.begin() as session:
        uncertain = await session.get(MediaJob, by_subject["s0"]["id"])
        uncertain.state = "submitting"
    jobs.start()
    async with asyncio.timeout(10):
        while True:
            reopened = (await client.get(uri)).json()
            if (
                next(j for j in reopened["jobs"] if j["id"] == by_subject["s0"]["id"])["state"]
                == "unknown"
            ):
                break
            await asyncio.sleep(0.1)
    await jobs.close()
    assert len(posts) == 8

    # 只重做指定的一镜，不影响时间线已经采用的音频和其它候选。
    current = (await client.get(uri)).json()
    result = await client.post(
        uri + "/jobs",
        json={
            "revision": current["revision"],
            "requestKey": "redo-shot",
            "shots": ["s2"],
        },
    )
    assert result.status_code == 200
    await run_stage()
    await run_stage()
    assert len(posts) == 9
    assert (await client.get(uri)).json()["document"] == current["document"]

    # DSH 提交沿用相同任务入口。预检不能收费，确认哈希必须对应同一版模型及工程。
    sid = (await client.post(uri + "/conversation")).json()["sessionId"]
    arguments = {"revision": current["revision"], "lines": ["l0"]}
    call = {"sessionId": sid, "receiptId": "director-media"}
    prepared = await services.studio_agent.execute(
        account, "studio_generate", arguments, {}, {**call, "phase": "prepare"}
    )
    plan = prepared["structuredContent"]
    assert plan["plan"]["items"][0]["characters"] == 2 and len(posts) == 9
    with pytest.raises(DomainError, match="重新确认"):
        await services.studio_agent.execute(
            account,
            "studio_generate",
            arguments,
            {},
            {**call, "phase": "execute", "authorizedPlanHash": "0" * 64},
        )
    submitted = await services.studio_agent.execute(
        account,
        "studio_generate",
        arguments,
        {},
        {**call, "phase": "execute", "authorizedPlanHash": plan["planHash"]},
    )
    assert len(submitted["structuredContent"]["jobs"]) == 1
    await run_stage()
    await run_stage()
    assert len(posts) == 10

    candidate = by_subject["s1"]
    imported = await client.post(
        uri + "/media/" + candidate["id"] + "/collect", json={"title": "已采用镜头"}
    )
    assert imported.status_code == 200, imported.text
    asset = imported.json()
    assert asset["sourceJob"] == candidate["id"] and asset["project"] == p
    address = uri + "/assets/" + asset["id"]
    assert (await client.post(address + "/access")).status_code == 200
    chunk = await client.get(address, headers={"Range": "bytes=4-7"})
    assert chunk.status_code == 206 and chunk.content == b"ftyp"
    assert (await client.post("/api/files/" + asset["fileId"] + "/trash")).status_code == 409
