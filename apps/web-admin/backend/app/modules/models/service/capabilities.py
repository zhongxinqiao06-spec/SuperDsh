"""供应商能力描述与参数规则，模型规格标识属于协议契约而非应用版本。"""

import re

from app.infrastructure.errors import DomainError


def schema(properties: dict[str, object]) -> dict[str, object]:
    return {"type": "object", "additionalProperties": False, "properties": properties}


CAPABILITIES: list[dict[str, object]] = [
    {
        "id": "chat",
        "name": "聊天与工具调用",
        "available": True,
        "inputTypes": ["text", "image"],
        "outputTypes": ["text", "tool-call"],
        "configurationSchema": schema(
            {
                "maxTokens": {
                    "type": "integer",
                    "title": "最大输出 Token",
                    "minimum": 1,
                    "maximum": 131072,
                },
                "contextWindow": {
                    "type": "integer",
                    "title": "上下文窗口 Token（按模型规格填写）",
                    "minimum": 1024,
                    "maximum": 10485760,
                },
            }
        ),
        "cancellation": "abort-request",
    },
    {
        "id": "image.generate",
        "name": "图片生成与参考图编辑",
        "available": True,
        "inputTypes": ["text", "image"],
        "outputTypes": ["image"],
        "configurationSchema": schema(
            {
                "imageProfile": {
                    "type": "string",
                    "title": "图片模型规格",
                    "enum": ["auto", "seedream-4", "seedream-5", "openai-images"],
                    "default": "auto",
                },
                "size": {"type": "string", "title": "输出尺寸／分辨率", "default": "2K"},
                "maxImages": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 4,
                    "default": 1,
                    "title": "最多参考图片数量",
                },
            }
        ),
        "cancellation": "abort-request",
    },
    {
        "id": "vision.analyze",
        "name": "视觉理解与页面检查",
        "available": True,
        "inputTypes": ["text", "image"],
        "outputTypes": ["text"],
        "configurationSchema": schema(
            {
                "maxTokens": {"type": "integer", "minimum": 1, "maximum": 16384, "default": 4096},
                "maxImages": {"type": "integer", "minimum": 1, "maximum": 10, "default": 4},
                "thinking": {
                    "type": "string",
                    "title": "火山视觉深度思考",
                    "enum": ["provider-default", "disabled", "enabled"],
                    "default": "disabled",
                    "x-superdsh-adapters": ["volcengine-ark"],
                    "x-superdsh-legacy-default": "provider-default",
                },
            }
        ),
        "cancellation": "abort-request",
    },
    *[
        {
            "id": key,
            "name": label,
            "available": False,
            "inputTypes": [],
            "outputTypes": [],
            "configurationSchema": schema({}),
            "cancellation": "unsupported",
        }
        for key, label in [
            ("speech.transcribe", "语音识别"),
            ("speech.synthesize", "语音合成"),
            ("video.generate", "视频生成"),
            ("embedding", "向量化"),
        ]
    ],
]


def validate_parameters(
    adapter: str, capability: str, model: str, values: dict[str, object]
) -> dict[str, object]:
    """维持既有能力边界，非法参数在保存前失败，不自动换供应商或降低配置。"""
    if capability not in {"chat", "image.generate", "vision.analyze"}:
        raise DomainError(422, "此能力尚未接入，暂不能启用")
    if adapter == "volcengine-speech" or (capability != "chat" and adapter == "anthropic-messages"):
        raise DomainError(422, "该连接尚未实现所选能力")
    allowed = {
        "chat": {"maxTokens", "contextWindow"},
        "image.generate": {"imageProfile", "size", "maxImages"},
        "vision.analyze": {"maxTokens", "maxImages", "thinking"},
    }[capability]
    if values.keys() - allowed:
        raise DomainError(422, "包含不允许的模型参数")

    def number(name: str, default: int, minimum: int, maximum: int) -> int:
        value = values.get(name, default)
        if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
            raise DomainError(422, f"{name} 超出允许范围")
        return value

    if capability == "image.generate":
        if adapter not in {"volcengine-ark", "openai-completions"}:
            raise DomainError(422, "当前连接不支持图片生成")
        requested = values.get("imageProfile", "auto")
        if not isinstance(requested, str) or requested not in {
            "auto",
            "seedream-4",
            "seedream-5",
            "openai-images",
        }:
            raise DomainError(422, "图片模型规格不受支持")
        inferred = (
            "openai-images"
            if adapter != "volcengine-ark"
            else "seedream-5"
            if re.search(r"seedream[-.]5", model, re.I)
            else "seedream-4"
            if re.search(r"seedream[-.]4", model, re.I)
            else "auto"
        )
        profile = inferred if requested == "auto" else requested
        if (adapter == "volcengine-ark") == (profile == "openai-images") or (
            inferred != "auto" and requested != "auto" and inferred != requested
        ):
            raise DomainError(422, "图片规格与供应商或模型版本不匹配")
        size = str(values.get("size", "2K" if adapter == "volcengine-ark" else "1536x1024"))
        if adapter != "volcengine-ark" and size not in {"1024x1024", "1536x1024", "1024x1536"}:
            raise DomainError(422, "图片尺寸不受支持")
        if adapter == "volcengine-ark":
            pixels = re.fullmatch(r"(\d{3,5})x(\d{3,5})", size)
            if size not in {"1K", "1.5K", "2K", "4K"} and not pixels:
                raise DomainError(422, "火山图片尺寸格式不正确")
            pro = profile == "seedream-5"
            if (
                (profile == "auto" and size != "2K")
                or (pro and size == "4K")
                or (not pro and size in {"1K", "1.5K"})
            ):
                raise DomainError(422, "图片尺寸与模型规格不匹配")
            if pixels:
                width, height = map(int, pixels.groups())
                if (
                    not (921600 if pro else 3686400)
                    <= width * height
                    <= (4624220 if pro else 16777216)
                    or not 1 / 16 <= width / height <= 16
                ):
                    raise DomainError(422, "图片像素或宽高比超过模型范围")
        return {"size": size, "imageProfile": profile, "maxImages": number("maxImages", 1, 1, 4)}
    result: dict[str, object] = {
        "maxTokens": number("maxTokens", 4096, 1, 131072 if capability == "chat" else 16384)
    }
    if capability == "chat" and "contextWindow" in values:
        result["contextWindow"] = number("contextWindow", 32768, 1024, 10485760)
    if capability == "vision.analyze":
        if "thinking" in values and adapter != "volcengine-ark":
            raise DomainError(422, "当前供应商不支持火山深度思考参数")
        thinking = values.get("thinking", "disabled")
        if not isinstance(thinking, str) or thinking not in {
            "provider-default",
            "disabled",
            "enabled",
        }:
            raise DomainError(422, "视觉深度思考模式不受支持")
        result["maxImages"] = number("maxImages", 4, 1, 10)
        if adapter == "volcengine-ark":
            result["thinking"] = thinking
    return result
