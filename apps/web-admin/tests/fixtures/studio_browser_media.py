"""仅在隔离浏览器库写入已完成的媒体回执与可播放文件。工程仍通过正式 API 保存。"""

import asyncio
import os
import sys
import wave
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from app.infrastructure.database import Database
from app.modules.identity.entity.do import models as identity_models
from app.modules.studio.entity.do import asset_do
from app.modules.studio.entity.do.models import MediaJob, StudioProject
from app.modules.studio.service.timeline_renderer import TimelineRenderer

# 独立种子进程也注册新增任务外键的目标；正式应用由服务装配完成同样注册。
MODEL_MODULES = (identity_models, asset_do)


def isolated_media() -> tuple[Path, str]:
    checkout = Path(__file__).resolve().parents[4]
    root = Path(os.environ["WEB_ADMIN_DATA_DIR"]).resolve() / "studio/media"
    validation = checkout / ".superdsh-work/web-admin-validation"
    url = os.environ["WEB_ADMIN_TEST_DATABASE_URL"]
    if not root.is_relative_to(validation) or url != os.environ["WEB_ADMIN_DATABASE_URL"]:
        raise RuntimeError("媒体验收只允许使用隔离测试库和工作目录")
    root.mkdir(parents=True, exist_ok=True)
    return root, url


async def seed(project_id: str, root: Path, url: str) -> None:
    database = Database(url)
    try:
        async with database.sessions.begin() as session:
            project = await session.get(StudioProject, project_id)
            if project is None or project.revision != 1:
                raise ValueError("需要本轮新建的空工程")
            renderer = TimelineRenderer(root)
            ids = []
            for index, color in enumerate(["teal", "navy", ""]):
                key = uuid4().hex
                if color:
                    await renderer.command(
                        root,
                        [
                            "-f",
                            "lavfi",
                            "-i",
                            f"color=c={color}:s=192x108:r=12",
                            "-t",
                            "2",
                            "-pix_fmt",
                            "yuv420p",
                            "-c:v",
                            "libx264",
                            "-movflags",
                            "+faststart",
                            key + ".mp4",
                        ],
                    )
                else:
                    with wave.open(str(root / (key + ".wav")), "wb") as audio:
                        audio.setparams((1, 2, 16000, 0, "NONE", ""))
                        audio.writeframes(bytes(32000))
                session.add(
                    MediaJob(
                        id=key,
                        project=project.id,
                        request_key=key,
                        subject="platform" if color else "platform-line",
                        kind="video" if color else "speech",
                        revision=1,
                        state="ready",
                        payload={"duration": 2000 if color else 1000},
                        updated=datetime.now(UTC) + timedelta(seconds=index),
                    )
                )
                ids.append(key)
        print(" ".join(ids))
    finally:
        await database.close()


if __name__ == "__main__":
    asyncio.run(seed(sys.argv[1], *isolated_media()))
