"""图片去重后仍保持人物与供应商参考序号一致，不让共享素材串角色。"""

from unittest.mock import AsyncMock, MagicMock

import pytest

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
                {"configurationId": "reference", "revision": 1, "capability": "video.generate"},
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
            "hero-outfit": {"name": "橙色造型", "kind": "character", "fileId": "orange-file"},
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
