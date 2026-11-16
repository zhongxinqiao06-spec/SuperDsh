"""真实 FFmpeg 验证横竖屏成片尺寸、解码与异画幅镜头留边，不调用供应商。"""

from pathlib import Path

import pytest
from PIL import Image

from app.modules.studio.entity.vo.studio_vo import Document
from app.modules.studio.service.timeline_renderer import TimelineRenderer


@pytest.mark.parametrize("aspect,dimensions", [((16, 9), (1280, 720)), ((9, 16), (720, 1280))])
async def test_export_preserves_project_canvas(
    tmp_path: Path, aspect: tuple[int, int], dimensions: tuple[int, int]
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
            "source.mp4",
        ],
    )
    document = Document.model_validate(
        {
            "shots": [
                {
                    "id": "opening",
                    "action": "试看片",
                    "candidate": "source",
                    "duration": 1000,
                }
            ]
        }
    )
    output = tmp_path / "film.mp4"
    await renderer.render(document, output, aspect=aspect)
    await renderer.command(tmp_path, ["-i", str(output), "-f", "null", "-"])
    await renderer.command(tmp_path, ["-i", str(output), "-frames:v", "1", "frame.png"])
    with Image.open(tmp_path / "frame.png") as frame:
        assert frame.size == dimensions
        pixels = frame.convert("RGB")
        # 异画幅的已采用镜头居中留边，不被裁成满屏或拉长；同画幅则覆盖画布。
        center = pixels.getpixel((dimensions[0] // 2, dimensions[1] // 2))
        corner = pixels.getpixel((10, 10))
        assert isinstance(center, tuple) and center[2] > 240
        assert isinstance(corner, tuple)
        assert max(corner) < 10 if aspect == (9, 16) else corner[2] > 240
