"""仅隔离浏览器使用的供应商替身；正式页面、服务、迁移与媒体队列仍真实运行。"""

import asyncio
import base64
import io
import json
import wave
from uuid import uuid4

import httpx
from fastapi import FastAPI
from PIL import Image

import app.main as application
from app.infrastructure.configuration import Settings
from app.launcher import main
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.studio.service.timeline_renderer import TimelineRenderer
from fixtures.studio_browser_media import isolated_media

root, _ = isolated_media()
clip = root / "fixture-clip.mp4"
asyncio.run(
    TimelineRenderer(root).command(
        root,
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=teal:s=192x108:r=12",
            "-t",
            "3",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-movflags",
            "+faststart",
            clip.name,
        ],
    )
)
picture, sound = io.BytesIO(), io.BytesIO()
Image.new("RGB", (320, 200), "#405d6d").save(picture, "PNG")
with wave.open(sound, "wb") as wav:
    wav.setparams((1, 2, 16000, 0, "NONE", ""))
    wav.writeframes(bytes(32000))
tasks: dict[str, str] = {}


def provider(request: httpx.Request) -> httpx.Response:
    if request.method == "POST" and request.url.path.endswith("/cancel"):
        tasks[request.url.path.split("/")[-2]] = "CANCELED"
        return httpx.Response(200, json={"output": {"task_status": "CANCELED"}})
    if request.method == "POST":
        data = json.loads(request.content)
        if "image" in request.url.path:
            return httpx.Response(
                200, json={"data": [{"b64_json": base64.b64encode(picture.getvalue()).decode()}]}
            )
        if "video" in request.url.path:
            identity = uuid4().hex
            prompt = data["input"]["prompt"]
            if "受理未知" in prompt:
                raise httpx.ReadTimeout("隔离供应商未返回受理回执", request=request)
            tasks[identity] = (
                "FAILED"
                if "受控失败" in prompt
                else "PENDING"
                if "等待取消" in prompt
                else "SUCCEEDED"
            )
            return httpx.Response(200, json={"output": {"task_id": identity}})
        return httpx.Response(
            200, json={"output": {"audio": {"url": "https://synthetic.invalid/audio.wav"}}}
        )
    if "/tasks/" in request.url.path:
        task = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(
            200,
            json={
                "output": {
                    "task_status": tasks.get(task, "UNKNOWN"),
                    "video_url": "https://synthetic.invalid/clip.mp4",
                }
            },
        )
    return httpx.Response(
        200, content=sound.getvalue() if request.url.path.endswith(".wav") else clip.read_bytes()
    )


original = application.create_app


def create_app(settings: Settings | None = None) -> FastAPI:
    app = original(settings)
    app.state.services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(provider)
    )
    return app


if __name__ == "__main__":
    application.create_app = create_app
    main()
