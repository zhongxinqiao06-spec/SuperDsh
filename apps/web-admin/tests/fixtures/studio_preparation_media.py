"""隔离浏览器准备阶段媒体：只伪造供应商已完成回执，采用走正式接口。"""

import asyncio
import json
import sys
import wave
from uuid import uuid4

from PIL import Image

from app.infrastructure.database import Database
from app.modules.studio.entity.do.models import MediaJob, StudioAsset, StudioProject
from fixtures.studio_browser_media import isolated_media


async def seed(project_id: str, asset_id: str, configuration: str, revision: int) -> None:
    root, url = isolated_media()
    database = Database(url)
    try:
        async with database.sessions.begin() as session:
            project = await session.get(StudioProject, project_id)
            asset = await session.get(StudioAsset, asset_id)
            if not project or not asset or asset.project != project.id:
                raise ValueError("必须使用本轮作品中的角色")
            output = {}
            for purpose, kind, color in [
                ("reference", "image", "#425c65"),
                ("reference", "image", "#775e50"),
                ("voice", "speech", ""),
            ]:
                identity = uuid4().hex
                if kind == "image":
                    Image.new("RGB", (640, 400), color).save(root / (identity + ".png"))
                else:
                    with wave.open(str(root / (identity + ".wav")), "wb") as audio:
                        audio.setparams((1, 2, 16000, 0, "NONE", ""))
                        audio.writeframes(bytes(32000))
                session.add(
                    MediaJob(
                        id=identity,
                        project=project.id,
                        revision=project.revision,
                        request_key=identity,
                        subject=asset.id,
                        kind=kind,
                        state="ready",
                        payload={
                            "owner": project.owner,
                            "purpose": purpose,
                            "family": asset.family,
                            "sourceVersion": asset.id,
                            "voice": "voice-b",
                            "text": "我们出发吧。",
                            "duration": 1000,
                            "binding": {
                                "configurationId": configuration,
                                "revision": revision,
                                "capability": "speech.synthesize",
                            },
                        },
                    )
                )
                output[purpose] = identity
            print(json.dumps(output))
    finally:
        await database.close()


if __name__ == "__main__":
    asyncio.run(seed(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])))
