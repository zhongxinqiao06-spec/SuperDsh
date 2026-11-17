"""百炼图片协议与收据恢复：合成模型不外发收费请求。"""

import io
import json
from pathlib import Path

import httpx
import pytest
from PIL import Image

from app.infrastructure.errors import DomainError
from app.modules.models.service.bailian_protocol import bailian_download
from app.modules.models.service.capabilities import validate_parameters
from app.modules.models.service.image_protocol import image_request, image_result
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.studio.service.image_provider import ImageProvider

BASE = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
PARAMETERS: dict[str, object] = {
    "imageProfile": "bailian-images",
    "size": "1536x1024",
    "maxImages": 3,
}


def test_reference_images_and_model_stay_in_configured_protocol() -> None:
    url, body = image_request(
        "openai-completions",
        "synthetic-image",
        PARAMETERS,
        "三角色设定",
        ["data:image/png;base64,c3ludGhldGlj"],
        BASE,
    )
    assert url.endswith("/api/v1/services/aigc/multimodal-generation/generation")
    assert "/compatible-mode/" not in url
    assert body == {
        "model": "synthetic-image",
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"image": "data:image/png;base64,c3ludGhldGlj"},
                        {"text": "三角色设定"},
                    ],
                }
            ]
        },
        "parameters": {"size": "1536*1024", "n": 1},
    }


@pytest.mark.parametrize("change", [{"size": {}}, {"maxImages": 4}, {"maxImages": True}])
def test_invalid_image_settings_fail_before_submission(change: dict) -> None:
    with pytest.raises(DomainError):
        validate_parameters(
            "openai-completions", "image.generate", "synthetic", {**PARAMETERS, **change}, BASE
        )


def test_wrong_connection_and_excess_references_fail_before_submission() -> None:
    with pytest.raises(DomainError):
        image_request(
            "openai-completions", "synthetic", PARAMETERS, "test", [], "https://other.invalid"
        )
    with pytest.raises(DomainError):
        image_request("openai-completions", "synthetic", PARAMETERS, "test", ["x"] * 4, BASE)


def test_result_and_download_do_not_accept_arbitrary_proxy_origin() -> None:
    with pytest.raises(DomainError):
        image_result({"output": {"choices": [{"message": {"content": [{"text": "no image"}]}}]}})
    url, allowed = bailian_download(
        "https://untrusted.invalid/a.png",
        "https://token-plan.cn-beijing.maas.aliyuncs.com",
        {"https://token-plan.cn-beijing.maas.aliyuncs.com"},
    )
    assert not allowed and url == "https://untrusted.invalid/a.png"
    url, allowed = bailian_download(
        "http://dashscope-result.oss-cn-beijing.aliyuncs.com/a.png",
        "https://token-plan.cn-beijing.maas.aliyuncs.com",
        {"https://token-plan.cn-beijing.maas.aliyuncs.com"},
    )
    assert allowed and url.startswith("https://")


async def test_image_receipt_retries_download_only(tmp_path: Path) -> None:
    output = io.BytesIO()
    Image.new("RGB", (40, 30), "gold").save(output, "PNG")
    requests: list[httpx.Request] = []
    unavailable = True

    def receive(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            assert json.loads(request.content)["model"] == "synthetic-image"
            return httpx.Response(
                200,
                json={
                    "output": {
                        "choices": [
                            {
                                "message": {
                                    "content": [
                                        {"image": "https://images.invalid/result.png"},
                                    ]
                                }
                            }
                        ]
                    }
                },
            )
        assert "authorization" not in request.headers
        return httpx.Response(503 if unavailable else 200, content=output.getvalue())

    transport = ProviderTransport(transport=httpx.MockTransport(receive))
    resolved = {
        "connection": {"adapter": "openai-completions", "baseUrl": BASE},
        "configuration": {"modelId": "synthetic-image", "parameters": PARAMETERS},
        "apiKey": "synthetic-private-key",
    }
    provider = ImageProvider(transport, resolved)
    receipt, image = tmp_path / "receipt.json", tmp_path / "image.png"
    await provider.generate("test", [], receipt)
    assert receipt.exists() and "synthetic-private-key" not in receipt.read_text()
    with pytest.raises(DomainError):
        await provider.result(receipt, image)
    assert not image.exists()
    unavailable = False
    await ImageProvider(transport, resolved).result(receipt, image)
    with Image.open(image) as generated:
        assert generated.size == (40, 30)
    assert [request.method for request in requests] == ["POST", "GET", "GET"]
