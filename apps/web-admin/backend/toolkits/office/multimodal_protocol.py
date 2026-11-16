"""多模态供应商协议纯方法；模型和凭据只能来自冻结配置。"""

import base64
import json
from typing import cast

from app.infrastructure.errors import DomainError
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.models.service.capabilities import validate_parameters
from app.modules.models.service.reference_protocol import vision_answer as vision_answer
from app.modules.models.service.reference_protocol import vision_request
from toolkits.office.contracts import InputFile, record, text
from toolkits.office.images import image_data


def prepared_plan(
    binding: CapabilityBinding,
    value: dict[str, object],
    configuration: dict[str, object],
) -> dict[str, object]:
    """确认方案保存明确的模型修订，不能以运行时默认值替换费用来源。"""
    source = record(
        value,
        "多模态方案",
        {"title", "prompt", "purpose", "size", "imageCount", "capabilityBinding"},
    )
    parameters = record(configuration.get("parameters", {}), "模型参数")
    return {
        "title": text(source.get("title"), "标题", 100),
        "prompt": text(source.get("prompt"), "提示词", 12000),
        "purpose": text(source.get("purpose", ""), "用途", 500, empty=True),
        "size": source.get("size") or parameters.get("size"),
        "imageCount": 1,
        "capabilityBinding": binding.model_dump(),
    }


def request_body(
    binding: CapabilityBinding,
    resolved: dict[str, object],
    plan: dict[str, object],
    images: list[InputFile],
) -> tuple[str, dict[str, object]]:
    """构造白名单供应商请求；不接收任意URL、密钥或自定义供应商请求体。"""
    configuration = record(resolved["configuration"], "模型配置")
    connection = record(resolved["connection"], "模型连接")
    parameters = record(configuration.get("parameters", {}), "模型参数")
    adapter, model = str(connection["adapter"]), str(configuration["modelId"])
    maximum = int(cast(int, parameters.get("maxImages", 4)))
    if len(images) > maximum:
        raise DomainError(422, "参考图片数量超过冻结配置上限")
    encoded: list[str] = []
    for source in images:
        image, _, _ = image_data(source)
        encoded.append("data:image/png;base64," + base64.b64encode(image).decode())
    prompt = text(plan.get("prompt"), "提示词", 12000)
    if binding.capability == "image.generate":
        values = validate_parameters(
            adapter,
            binding.capability,
            model,
            {
                **parameters,
                **({"size": plan["size"]} if plan.get("size") else {}),
            },
        )
        if encoded and adapter != "volcengine-ark":
            raise DomainError(422, "此适配器尚未声明参考图编辑能力")
        body: dict[str, object] = {
            "model": model,
            "prompt": prompt,
            "size": values["size"],
            "response_format": "b64_json",
            **({"watermark": True} if adapter == "volcengine-ark" else {"n": 1}),
        }
        if encoded:
            body["image"] = encoded[0] if len(encoded) == 1 else encoded
        endpoint = "/images/generations"
    elif binding.capability == "vision.analyze":
        endpoint, body = vision_request(adapter, model, parameters, prompt, encoded)
    else:
        raise DomainError(422, "此工具不支持所选模型能力")
    if len(json.dumps(body, ensure_ascii=False).encode()) > 32 * 1024 * 1024:
        raise DomainError(413, "模型输入超过处理上限")
    return endpoint, body
