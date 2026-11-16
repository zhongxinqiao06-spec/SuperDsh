"""显式注入测试授权后运行。复用回执，重启只查询已提交的镜头。"""

import asyncio
import base64
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.studio.entity.vo.studio_vo import Document
from app.modules.studio.service.bailian_media import BailianMedia
from app.modules.studio.service.timeline_renderer import TimelineRenderer


async def check(
    name: str,
    model: str,
    voice: str = "",
    prompt: str = "",
    references: list[str] | None = None,
) -> None:
    root = Path(os.environ["STUDIO_CHECK_DIR"])
    await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
    receipt = root / (name + ".json")
    output = root / (name + (".wav" if voice else ".mp4"))
    transport = ProviderTransport(os.environ["STUDIO_ALLOWED_ORIGINS"])

    def client() -> BailianMedia:
        return BailianMedia(
            transport,
            os.environ["STUDIO_BASE_URL"],
            os.environ["STUDIO_API_KEY"],
            model,
        )

    if output.exists():
        print(name, "已完成", output.stat().st_size)
        return
    if not receipt.exists():
        with receipt.open("x") as file:
            json.dump({"state": "submitting"}, file)
        if voice:
            result = {
                "url": await client().speech(
                    "小林，雨停了。" if name == "voice-a" else "我们出发吧。", voice
                )
            }
        else:
            result = {
                "task": await client().video(
                    prompt or "雨夜的石板路，暖光映在水面上，缓慢向前移动的镜头。",
                    5,
                    references,
                )
            }
        receipt.write_text(json.dumps(result))
    state = json.loads(receipt.read_text())
    if "task" in state:
        for _ in range(120):
            status, url = await client().status(state["task"])
            if status == "SUCCEEDED":
                break
            if status not in {"PENDING", "RUNNING"}:
                raise RuntimeError(status)
            await asyncio.sleep(8)
        else:
            raise RuntimeError("等待超时，保留回执")
    elif "url" in state:
        url = state["url"]
    else:
        raise RuntimeError("受理结果未知，须先核对")
    print(name, "取回媒体", urlsplit(url).hostname, flush=True)
    await client().download(url, output)
    print(name, "已验证", output.stat().st_size, flush=True)


async def main() -> None:
    voices = os.environ["STUDIO_VOICES"].split(",")
    results = await asyncio.gather(
        check("shot", os.environ["STUDIO_VIDEO_MODEL"]),
        check("voice-a", os.environ["STUDIO_TTS_MODEL"], voices[0]),
        check("voice-b", os.environ["STUDIO_TTS_MODEL"], voices[1]),
        return_exceptions=True,
    )
    errors = [str(result) for result in results if isinstance(result, Exception)]
    if errors:
        raise SystemExit("；".join(errors))
    if reference_model := os.getenv("STUDIO_REFERENCE_MODEL"):
        # 同一套回执允许在网络恢复后继续完整验收。以首镜的一帧作为第三镜的来源。
        root = Path(os.environ["STUDIO_CHECK_DIR"])
        renderer = TimelineRenderer(root)
        await renderer.command(root, ["-i", "shot.mp4", "-frames:v", "1", "reference.jpg"])
        ref = (
            "data:image/jpeg;base64,"
            + base64.b64encode((root / "reference.jpg").read_bytes()).decode()
        )
        await asyncio.gather(
            check(
                "station",
                os.environ["STUDIO_VIDEO_MODEL"],
                prompt="黄昏车站，一位穿蓝色外套的人走上站台，全景。",
            ),
            check(
                "rain",
                reference_model,
                prompt="镜头缓缓靠近[Image 1]的雨夜路面，保持暖色倒影。",
                references=[ref],
            ),
            check(
                "train",
                os.environ["STUDIO_VIDEO_MODEL"],
                prompt="清晨，一列火车穿过薄雾，慢慢离开站台。",
            ),
        )
        doc = Document.model_validate(
            {
                "shots": [
                    {
                        "id": shot,
                        "action": shot,
                        "candidate": shot,
                        "trimEnd": 3000 if i == 0 else None,
                        "lines": [
                            {
                                "id": "line" + str(i),
                                "role": voice,
                                "audio": voice,
                                "text": words,
                                "subtitleStart": 200,
                                "end": 2000,
                            }
                        ],
                    }
                    for i, (shot, voice, words) in enumerate(
                        [
                            ("shot", "voice-a", "小林，雨停了。"),
                            ("station", "voice-b", "我们出发吧。"),
                            ("rain", "voice-a", "小林，雨停了。"),
                            ("train", "voice-b", "我们出发吧。"),
                        ]
                    )
                ]
            }
        )
        await renderer.render(doc, root / "final.mp4")
        await renderer.command(root, ["-i", "final.mp4", "-f", "null", "-"])
        print("四镜双音色成片已完整解码", (root / "final.mp4").stat().st_size)


if __name__ == "__main__":
    asyncio.run(main())
