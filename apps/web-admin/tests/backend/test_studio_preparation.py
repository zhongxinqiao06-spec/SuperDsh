"""准备阶段真实接口回归：确认失效、三方合并、图像与音色候选和隔离。"""

import base64
import io
import json
import wave
from copy import deepcopy
from pathlib import Path

import httpx
import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image

from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.studio.entity.do.models import MediaJob


def preparation_configuration(tmp_path: Path) -> dict[str, object]:
    path = tmp_path / "models.json"
    path.write_text(
        json.dumps(
            {
                "connections": [
                    {
                        "id": "images",
                        "name": "受控图片",
                        "adapter": "volcengine-ark",
                        "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
                        "apiKey": "synthetic",
                        "enabled": True,
                    },
                    {
                        "id": "speech",
                        "name": "受控配音",
                        "adapter": "openai-completions",
                        "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
                        "apiKey": "synthetic",
                        "enabled": True,
                    },
                ],
                "configurations": [
                    {
                        "id": "picture",
                        "name": "参考图模型",
                        "connectionId": "images",
                        "capability": "image.generate",
                        "modelId": "seedream-4-synthetic",
                        "enabled": True,
                        "roleIds": [],
                        "parameters": {"size": "2K", "maxImages": 4},
                    },
                    {
                        "id": "voice",
                        "name": "双音色模型",
                        "connectionId": "speech",
                        "capability": "speech.synthesize",
                        "modelId": "synthetic-tts",
                        "enabled": True,
                        "roleIds": [],
                        "parameters": {"voices": "a,b"},
                    },
                ],
                "defaults": {"image.generate": "picture", "speech.synthesize": "voice"},
            }
        ),
        encoding="utf-8",
    )
    return {"model_defaults_file": path}


@pytest.fixture
def platform_settings(tmp_path: Path) -> dict[str, object]:
    return preparation_configuration(tmp_path)


async def create(client: AsyncClient) -> tuple[str, dict]:
    response = await client.post(
        "/api/studio/projects",
        json={"title": "两人雨夜", "aspectWidth": 9, "aspectHeight": 16, "targetDurationMs": 20000},
    )
    assert response.status_code == 200, response.text
    project = response.json()["id"]
    role = (
        await client.post(
            "/api/studio/assets",
            json={"kind": "character", "name": "小林", "description": "蓝外套", "project": project},
        )
    ).json()["id"]
    document = {
        "script": "小林说：我们出发吧。",
        "adaptationMode": "original",
        "assets": [role],
        "shots": [
            {
                "id": "station",
                "action": "站台重逢",
                "references": [role],
                "lines": [{"id": "hello", "role": role, "text": "我们出发吧。"}],
            }
        ],
    }
    response = await client.put(
        f"/api/studio/projects/{project}", json={"revision": 1, "document": document}
    )
    assert response.status_code == 200, response.text
    return f"/api/studio/projects/{project}", (
        await client.get(f"/api/studio/projects/{project}")
    ).json()


async def test_confirm_and_three_way_review(platform: tuple[FastAPI, AsyncClient]) -> None:
    _, client = platform
    await bootstrap(client)
    uri, project = await create(client)
    confirmation = {
        "revision": project["revision"],
        "requestKey": "confirm-script",
        "acknowledged": True,
    }
    assert (await client.post(uri + "/stages/script/confirm", json=confirmation)).status_code == 200
    assert (await client.post(uri + "/stages/script/confirm", json=confirmation)).status_code == 200
    state = (await client.get(uri + "/preparation")).json()
    assert state["stages"][0]["status"] == "confirmed"
    assert len(state["stages"][1]["issues"]) == 2
    proposed = deepcopy(project["document"])
    proposed["shots"][0].update(action="改为雨夜", camera="远景")
    response = await client.post(
        uri + "/proposals",
        json={"revision": project["revision"], "requestKey": "proposal", "document": proposed},
    )
    assert response.status_code == 200, response.text
    proposal = response.json()["id"]
    manual = deepcopy(project["document"])
    manual["shots"][0].update(action="手工保留的黄昏", trimEnd=4000)
    response = await client.put(uri, json={"revision": project["revision"], "document": manual})
    assert response.status_code == 200
    comparison = (await client.get(uri + f"/proposals/{proposal}")).json()
    assert next(c for c in comparison["changes"] if c["key"] == "shot:station:action")["conflict"]
    invalid = {
        "revision": comparison["revision"],
        "requestKey": "review",
        "selected": ["shot:station:action"],
    }
    assert (
        await client.post(uri + f"/proposals/{proposal}/review", json=invalid)
    ).status_code == 409
    accepted = {**invalid, "selected": ["shot:station:camera"]}
    response = await client.post(uri + f"/proposals/{proposal}/review", json=accepted)
    assert response.status_code == 200, response.text
    assert (
        await client.post(uri + f"/proposals/{proposal}/review", json=accepted)
    ).json() == response.json()
    current = (await client.get(uri)).json()
    shot = current["document"]["shots"][0]
    assert (shot["action"], shot["camera"], shot["trimEnd"], shot["lines"][0]["text"]) == (
        "手工保留的黄昏",
        "远景",
        4000,
        "我们出发吧。",
    )
    assert (await client.get(uri + "/preparation")).json()["stages"][0]["status"] == "confirmed"
    rewrite = deepcopy(current["document"])
    rewrite["script"] = "导演重写"
    assert (
        await client.post(
            uri + "/proposals",
            json={
                "revision": current["revision"],
                "requestKey": "original-protection",
                "document": rewrite,
            },
        )
    ).status_code == 422
    assert (
        await client.put(uri, json={"revision": current["revision"], "document": rewrite})
    ).status_code == 200
    assert (await client.get(uri + "/preparation")).json()["stages"][0]["status"] == "stale"
    other = (await client.post("/api/studio/projects", json={"title": "另一作品"})).json()["id"]
    assert (
        await client.get(f"/api/studio/projects/{other}/proposals/{proposal}")
    ).status_code == 404


async def test_reference_voice_candidate_adoption(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    await bootstrap(client)
    media = app.state.services.media_jobs
    await media.close()
    media.root.mkdir(parents=True, exist_ok=True)
    picture = io.BytesIO()
    Image.new("RGB", (96, 64), "teal").save(picture, "PNG")
    sound = io.BytesIO()
    with wave.open(sound, "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", ""))
        wav.writeframes(bytes(32000))
    calls: list[str] = []

    def provider(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            calls.append(request.url.path)
            if request.url.path.endswith("/images/generations"):
                return httpx.Response(
                    200,
                    json={"data": [{"b64_json": base64.b64encode(picture.getvalue()).decode()}]},
                )
            return httpx.Response(
                200, json={"output": {"audio": {"url": "https://audio.invalid/voice.wav"}}}
            )
        return httpx.Response(200, content=sound.getvalue())

    app.state.services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(provider)
    )
    uri, project = await create(client)
    role = project["document"]["assets"][0]
    other = (
        await client.post(
            "/api/studio/assets",
            json={
                "kind": "character",
                "name": "小禾",
                "description": "灰色风衣",
                "project": project["id"],
            },
        )
    ).json()["id"]
    document = deepcopy(project["document"])
    document["script"] += "小禾说：好。"
    document["assets"].append(other)
    for identity in ["arrival", "rain", "departure"]:
        document["shots"].append(
            {
                "id": identity,
                "action": "雨后站台的" + identity,
                "duration": 5000,
                "references": [other],
                "lines": [{"id": identity + "-line", "role": other, "text": "好。"}],
            }
        )
    assert (
        await client.put(uri, json={"revision": project["revision"], "document": document})
    ).status_code == 200

    async def process(job: str) -> None:
        for _ in range(3):
            async with media.database.sessions() as session:
                row = await session.get(MediaJob, job)
                assert row is not None
            if row.state == "ready":
                break
            await media.process(row)
        current = (await client.get(uri)).json()
        assert next(j for j in current["jobs"] if j["id"] == job)["state"] == "ready", current[
            "jobs"
        ]

    async def generate(kind: str, key: str, target: str, **values: object) -> str:
        current = (await client.get(uri)).json()
        body = {
            "revision": current["revision"],
            "requestKey": key,
            "kind": kind,
            "target": target,
            **values,
        }
        count = len(calls)
        response = await client.post(uri + "/preparation/jobs?preview=true", json=body)
        assert response.status_code == 200, response.text
        assert len(calls) == count
        body["planHash"] = response.json()["planHash"]
        response = await client.post(uri + "/preparation/jobs", json=body)
        assert response.status_code == 200, response.text
        job = response.json()["job"]["id"]
        assert (await client.post(uri + "/preparation/jobs", json=body)).json()["job"]["id"] == job
        await process(job)
        return job

    image = await generate("reference", "image", role)
    current = (await client.get(uri)).json()
    assert not next(a for a in current["assets"] if a["id"] == role)["fileId"]
    adopt = {
        "revision": current["revision"],
        "requestKey": "adopt-image",
        "job": image,
        "target": role,
    }
    response = await client.post(uri + "/preparation/adopt", json=adopt)
    assert response.status_code == 200, response.text
    role = response.json()["asset"]
    assert (await client.post(uri + "/preparation/adopt", json=adopt)).json() == response.json()
    voice = await generate("voice", "voice", role, voice="b", text="我们出发吧。")
    current = (await client.get(uri)).json()
    response = await client.post(
        uri + "/preparation/adopt",
        json={
            "revision": current["revision"],
            "requestKey": "adopt-voice",
            "job": voice,
            "target": role,
        },
    )
    assert response.status_code == 200, response.text
    role = response.json()["asset"]
    current = (await client.get(uri)).json()
    adopted = next(a for a in current["assets"] if a["id"] == role)
    assert adopted["voice"] == "b" and adopted["fileId"]
    assert (
        adopted["voiceBinding"]["configurationId"] == "voice"
        and adopted["voicePreviewJob"] == voice
    )
    assert current["document"]["shots"][0]["lines"][0]["role"] == role
    assert current["document"]["shots"][0]["lines"][0]["text"] == "我们出发吧。"
    for kind, values in [("reference", {}), ("voice", {"voice": "a", "text": "好。"})]:
        candidate = await generate(kind, "other-" + kind, other, **values)
        current = (await client.get(uri)).json()
        response = await client.post(
            uri + "/preparation/adopt",
            json={
                "revision": current["revision"],
                "requestKey": "other-adopt-" + kind,
                "job": candidate,
                "target": other,
            },
        )
        assert response.status_code == 200, response.text
        other = response.json()["asset"]
    assert not (await client.get(uri + "/preparation")).json()["stages"][1]["issues"]
    current = (await client.get(uri)).json()
    for stage in ["script", "cast", "storyboard"]:
        response = await client.post(
            uri + "/stages/" + stage + "/confirm",
            json={
                "revision": current["revision"],
                "requestKey": "complete-" + stage,
                "acknowledged": True,
            },
        )
        assert response.status_code == 200, response.text
    assert len(current["document"]["shots"]) == 4
    assert next(a for a in current["assets"] if a["id"] == other)["voice"] == "a"
    board = await generate("storyboard", "board", "station")
    current = (await client.get(uri)).json()
    response = await client.post(
        uri + "/preparation/adopt",
        json={
            "revision": current["revision"],
            "requestKey": "adopt-board",
            "job": board,
            "target": "station",
        },
    )
    assert response.status_code == 200, response.text
    assert len(calls) == 5
    current = (await client.get(uri)).json()
    assert role in current["document"]["shots"][0]["references"]
    assert len(current["document"]["shots"][0]["references"]) == 2
    assert current["document"]["shots"][0]["lines"][0]["audio"] is None


async def test_preflight_and_unknown_submission(platform: tuple[FastAPI, AsyncClient]) -> None:
    """无效音色与过期计划先拒绝；提交超时保留未知，不因同号重试重复收费。"""
    app, client = platform
    await bootstrap(client)
    media = app.state.services.media_jobs
    await media.close()
    uri, project = await create(client)
    body = {
        "revision": project["revision"],
        "requestKey": "negative",
        "kind": "voice",
        "target": project["document"]["assets"][0],
        "voice": "not-configured",
        "text": "试听",
    }
    assert (await client.post(uri + "/preparation/jobs?preview=true", json=body)).status_code == 422
    body.update(kind="reference", voice="")
    preview = await client.post(uri + "/preparation/jobs?preview=true", json=body)
    assert preview.status_code == 200, preview.text
    assert not (await client.get(uri)).json()["jobs"]
    assert (
        await client.post(uri + "/preparation/jobs", json={**body, "planHash": "0" * 64})
    ).status_code == 409
    calls = []

    def timeout(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        raise httpx.ReadTimeout("synthetic timeout")

    app.state.services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(timeout)
    )
    body["planHash"] = preview.json()["planHash"]
    submitted = await client.post(uri + "/preparation/jobs", json=body)
    assert submitted.status_code == 200, submitted.text
    identity = submitted.json()["job"]["id"]
    async with media.database.sessions() as session:
        job = await session.get(MediaJob, identity)
        assert job is not None
    await media.process(job)
    repeated = await client.post(uri + "/preparation/jobs", json=body)
    assert repeated.json()["job"]["id"] == identity
    assert repeated.json()["job"]["state"] == "unknown"
    assert len(calls) == 1
    assert (
        await client.post(uri + "/preparation/jobs", json={**body, "prompt": "另一个请求"})
    ).status_code == 409
    confirmation = {
        "revision": project["revision"],
        "requestKey": "sample-review",
        "acknowledged": True,
        "shots": ["station"],
    }
    assert (await client.post(uri + "/stages/sample/confirm", json=confirmation)).status_code == 422
    skipped = {**confirmation, "decision": "skipped", "reason": "本次仅验证静态分镜"}
    assert (await client.post(uri + "/stages/sample/confirm", json=skipped)).status_code == 200
    assert (
        await client.post(
            uri + "/stages/script/confirm", json={**skipped, "requestKey": "skip-script"}
        )
    ).status_code == 422
