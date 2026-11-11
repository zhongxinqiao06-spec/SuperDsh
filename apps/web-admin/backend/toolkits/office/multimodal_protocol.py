"""多模态供应商协议纯方法；模型和凭据只能来自冻结配置。"""

import base64
import json
from typing import cast

from app.infrastructure.errors import DomainError
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.models.service.capabilities import validate_parameters
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
        if not encoded:
            raise DomainError(422, "视觉理解至少需要一张已授权图片")
        if adapter in {"volcengine-ark", "openai-responses"}:
            endpoint = "/responses"
            body = {
                "model": model,
                "store": False,
                "max_output_tokens": parameters.get("maxTokens", 4096),
                "input": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": prompt},
                            *[{"type": "input_image", "image_url": value} for value in encoded],
                        ],
                    }
                ],
            }
            if adapter == "volcengine-ark" and parameters.get("thinking") in {
                "enabled",
                "disabled",
            }:
                body["thinking"] = {"type": parameters["thinking"]}
        elif adapter == "openai-completions":
            endpoint = "/chat/completions"
            body = {
                "model": model,
                "max_tokens": parameters.get("maxTokens", 4096),
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            *[
                                {"type": "image_url", "image_url": {"url": value}}
                                for value in encoded
                            ],
                        ],
                    }
                ],
            }
        else:
            raise DomainError(422, "当前连接不支持视觉理解")
    else:
        raise DomainError(422, "此工具不支持所选模型能力")
    if len(json.dumps(body, ensure_ascii=False).encode()) > 32 * 1024 * 1024:
        raise DomainError(413, "模型输入超过处理上限")
    return endpoint, body


def vision_answer(value: dict[str, object]) -> str:
    """只有供应商正常结束的可见正文才算完成，推理文本不能冒充回答。"""
    choices = value.get("choices")
    first = choices[0] if isinstance(choices, list) and choices else {}
    first = first if isinstance(first, dict) else {}
    if value.get("status") == "incomplete" or first.get("finish_reason") == "length":
        raise DomainError(
            502,
            "视觉分析达到输出上限或未完整结束，请调整配置后重新确认；未重试收费调用",
            "vision_response_incomplete",
        )
    if value.get("status") in {"failed", "cancelled"} or value.get("error"):
        raise DomainError(502, "视觉供应商未完成分析；未自动重试收费调用")
    output = value.get("output")
    answer = ""
    if isinstance(output, list):
        texts: list[str] = []
        for item in output:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            content = item.get("content")
            if isinstance(content, list):
                texts.extend(
                    str(part["text"])
                    for part in content
                    if isinstance(part, dict)
                    and part.get("type") == "output_text"
                    and isinstance(part.get("text"), str)
                )
        answer = "\n".join(texts)
    else:
        message = first.get("message")
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            answer = message["content"]
    if not answer.strip() or len(answer) > 512 * 1024:
        raise DomainError(502, "视觉服务未返回有效正文或正文过大")
    return answer
