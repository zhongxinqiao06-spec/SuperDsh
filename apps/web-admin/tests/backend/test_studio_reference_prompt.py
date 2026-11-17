"""图片去重后仍保持人物与供应商参考序号一致，不让共享素材串角色。"""

import io
from unittest.mock import AsyncMock, MagicMock

import pytest
from PIL import Image

from app.infrastructure.errors import DomainError
from app.modules.studio.service.generation_inputs import GenerationInputs


async def test_reference_subjects_follow_deduplicated_image_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inputs = GenerationInputs.__new__(GenerationInputs)
    inputs.media = MagicMock()
    monkeypatch.setattr(inputs, "images", AsyncMock(return_value=["orange-file", "palm-file"]))
    monkeypatch.setattr(
        inputs,
        "model",
        AsyncMock(
            return_value=(
                {
                    "configurationId": "reference",
                    "revision": 1,
                    "capability": "video.generate",
                },
                {
                    "connection": {
                        "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
                    },
                    "apiKey": "synthetic",
                    "configuration": {"modelId": "synthetic", "name": "受控参考模型"},
                },
            )
        ),
    )
    result = await inputs.video(
        {
            "references": ["hero", "hero-outfit", "beach"],
            "lines": [{"role": "hero"}],
            "duration": 5000,
            "action": "噜噜在椰林沙滩散步",
            "scene": "海滩",
            "framing": "中景",
            "camera": "平视",
            "movement": "跟拍",
        },
        {
            "hero": {"name": "噜噜", "kind": "character", "fileId": "orange-file"},
            "hero-outfit": {
                "name": "橙色造型",
                "kind": "character",
                "fileId": "orange-file",
            },
            "beach": {"name": "椰林", "kind": "scene", "fileId": "palm-file"},
        },
        {},
        {"aspectWidth": 9, "aspectHeight": 16},
    )
    assert result["images"] == ["orange-file", "palm-file"]
    assert "[Image 1] 中的主体：噜噜、橙色造型" in result["prompt"]
    assert "[Image 2] 中的主体：椰林" in result["prompt"]
    assert "[Image 3]" not in result["prompt"]
    assert result["aspect"] == "9:16" and result["seconds"] == 5


async def test_small_reference_is_editable_but_rejected_before_video_submission() -> None:
    """同一预检缓存先供图片编辑使用，也不能绕过后续视频的最低尺寸要求。"""
    picture = io.BytesIO()
    Image.new("RGB", (85, 80), "white").save(picture, "PNG")
    media = MagicMock()
    media.studio.files.entry = AsyncMock(
        return_value={"mediaType": "image/png", "size": len(picture.getvalue())}
    )
    media.studio.files.read = AsyncMock(return_value=(picture.getvalue(), {}))
    inputs = GenerationInputs(media, MagicMock(), {})
    assert await inputs.images(["reference"], 4) == ["reference"]
    with pytest.raises(DomainError, match="至少 300×300"):
        await inputs.images(["reference"], 9, minimum_side=300)
    media.studio.files.read.assert_awaited_once()


async def test_video_reference_accepts_minimum_dimensions() -> None:
    picture = io.BytesIO()
    Image.new("RGB", (300, 300), "white").save(picture, "PNG")
    media = MagicMock()
    media.studio.files.entry = AsyncMock(
        return_value={"mediaType": "image/png", "size": len(picture.getvalue())}
    )
    media.studio.files.read = AsyncMock(return_value=(picture.getvalue(), {}))
    inputs = GenerationInputs(media, MagicMock(), {})
    assert await inputs.images(["reference"], 9, minimum_side=300) == ["reference"]
