"""用户显式授权的真实多模态验收；图片只留内存，证据不保存凭据或响应原文。"""

import argparse
import asyncio
import base64
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw

from app.infrastructure.errors import DomainError
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.models.service.capabilities import validate_parameters
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.models.service.startup_configuration import load_startup_models
from toolkits.office.contracts import InputFile, record
from toolkits.office.multimodal_protocol import request_body, vision_answer

ROOT = Path(__file__).resolve().parents[4]


def synthetic_image() -> InputFile:
    """只上传合成红色方块，不读取截图、用户文件或会话数据。"""
    with Image.new("RGB", (256, 256), "white") as image:
        ImageDraw.Draw(image).rectangle((64, 64, 192, 192), fill="red")
        output = io.BytesIO()
        image.save(output, "PNG")
        return InputFile("synthetic-square.png", output.getvalue())


def image_result(value: dict[str, object]) -> dict[str, object]:
    """验证供应商确实返回一张可解码位图，不把 HTTP 成功当作生成成功。"""
    images = value.get("data")
    if not isinstance(images, list) or len(images) != 1:
        raise ValueError("expected one generated image")
    encoded = record(images[0], "图片").get("b64_json")
    if not isinstance(encoded, str):
        raise ValueError("expected image bytes")
    raw = base64.b64decode(encoded, validate=True)
    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        if image.format not in {"PNG", "JPEG", "WEBP"} or min(image.size) < 64:
            raise ValueError("invalid generated image")
        return {"format": image.format, "width": image.width, "height": image.height}


async def run(
    config: Path, output: Path, identifiers: list[str], allowed_origins: list[str]
) -> bool:
    """每种能力至多一次提交，失败不重试；生图另外验证一次参考图编辑请求。"""
    document = await asyncio.to_thread(load_startup_models, config)
    connections = {item.id: item for item in document.connections}
    configurations = {item.id: item for item in document.configurations}
    selected = [configurations[identifier] for identifier in identifiers]
    if not selected or any(
        item.capability not in {"image.generate", "vision.analyze"}
        or not item.enabled
        or not connections[item.connectionId].enabled
        for item in selected
    ):
        raise ValueError("only enabled multimodal configurations may be probed")
    # 只允许写入验证目录，不把测试过程文件写进源码或正式配置目录。
    resolved_output = await asyncio.to_thread(output.resolve)
    if not resolved_output.is_relative_to(ROOT / ".superdsh-work/web-admin-validation"):
        raise ValueError("evidence must stay in the validation directory")
    await asyncio.to_thread(output.parent.mkdir, parents=True, exist_ok=True)
    results: list[dict[str, object]] = []
    transport = ProviderTransport(",".join(allowed_origins))
    for item in selected:
        connection = connections[item.connectionId]
        if not connection.apiKey or not connection.apiKey.get_secret_value():
            raise ValueError("explicit live probe requires a configured credential")
        parameters = validate_parameters(
            connection.adapter, item.capability, item.modelId, item.parameters
        )
        resolved: dict[str, object] = {
            "connection": {"adapter": connection.adapter},
            "configuration": {"modelId": item.modelId, "parameters": parameters},
        }
        binding = CapabilityBinding(capability=item.capability, configurationId=item.id, revision=1)
        cases = (
            ["vision"] if item.capability == "vision.analyze" else ["generate", "reference-edit"]
        )
        for case in cases:
            result: dict[str, object] = {
                "configurationId": item.id,
                "modelId": item.modelId,
                "capability": item.capability,
                "case": case,
            }
            try:
                prompt = {
                    "vision": "图中正中央的正方形是什么颜色？只回答颜色名称。",
                    "generate": "白色背景中央一个蓝色圆形，简洁几何图形，不要文字。",
                    "reference-edit": "保留参考图的白色背景和布局，把中央红色方块改成绿色圆形。",
                }[case]
                endpoint, body = request_body(
                    binding,
                    resolved,
                    {"prompt": prompt},
                    [] if case == "generate" else [synthetic_image()],
                )
                response = await transport.request(
                    "POST",
                    connection.baseUrl.rstrip("/") + endpoint,
                    {"Authorization": "Bearer " + connection.apiKey.get_secret_value()},
                    body,
                )
                if case == "vision":
                    answer = vision_answer(response)
                    if "红" not in answer and "red" not in answer.lower():
                        raise ValueError("visual answer did not match the synthetic image")
                    result["answerMatched"] = True
                else:
                    result.update(image_result(response))
                result["passed"] = True
            except Exception as error:
                result.update(passed=False, errorType=type(error).__name__)
                if isinstance(error, DomainError):
                    result["status"] = error.status
                    result["detail"] = error.detail
            results.append(result)
            await asyncio.to_thread(
                output.write_text,
                json.dumps(
                    {"externalModels": True, "results": results, "imagesPersisted": False},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            print(json.dumps(result, ensure_ascii=True), flush=True)
            if not result["passed"]:
                break
    return all(item["passed"] for item in results)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--configuration", action="append", required=True)
    parser.add_argument("--allowed-origin", action="append", default=[])
    parser.add_argument("--allow-external", action="store_true")
    args = parser.parse_args()
    if not args.allow_external:
        parser.error("真实调用必须由用户明确授权，并指定 --allow-external")
    raise SystemExit(
        0
        if asyncio.run(run(args.config, args.output, args.configuration, args.allowed_origin))
        else 1
    )
