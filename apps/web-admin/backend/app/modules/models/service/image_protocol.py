"""公共生图协议：创作台与通用 AI 工具使用同一请求、结果和下载规则。"""

from app.infrastructure.errors import DomainError
from app.modules.models.service.bailian_protocol import (
    bailian_download,
    bailian_origin,
    bailian_routes,
)
from app.modules.models.service.capabilities import validate_parameters
from app.modules.models.service.provider_transport import ProviderTransport


def supports_reference_images(adapter: str, parameters: dict) -> bool:
    return adapter == "volcengine-ark" or (
        adapter == "openai-completions" and parameters.get("imageProfile") == "bailian-images"
    )


def image_request(
    adapter: str,
    model: str,
    parameters: dict[str, object],
    prompt: str,
    images: list[str],
    base_url: str,
) -> tuple[str, dict[str, object]]:
    """只生成一张；收费请求由调用者的持久任务或工具收据约束，不在适配器重试。"""
    values = validate_parameters(adapter, "image.generate", model, parameters, base_url)
    if len(images) > int(str(values["maxImages"])):
        raise DomainError(422, "参考图片数量超过冻结配置上限")
    if images and not supports_reference_images(adapter, values):
        raise DomainError(422, "当前连接不支持参考图编辑")
    if values["imageProfile"] == "bailian-images":
        content = [{"image": image} for image in images] + [{"text": prompt}]
        return bailian_origin(base_url) + bailian_routes().image, {
            "model": model,
            "input": {"messages": [{"role": "user", "content": content}]},
            "parameters": {"size": str(values["size"]).replace("x", "*"), "n": 1},
        }
    body: dict[str, object] = {
        "model": model,
        "prompt": prompt,
        "size": values["size"],
        "response_format": "b64_json",
        **({"watermark": True} if adapter == "volcengine-ark" else {"n": 1}),
    }
    if images:
        body["image"] = images[0] if len(images) == 1 else images
    return base_url.rstrip("/") + "/images/generations", body


def image_result(receipt: dict) -> dict:
    """兼容已持久化的历史收据；提取图片，不把供应商正文或签名地址暴露给界面。"""
    data = receipt.get("data")
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return dict(data[0])
    output = receipt.get("output")
    choices = output.get("choices") if isinstance(output, dict) else None
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        message = choices[0].get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("image"), str):
                    return {"url": item["image"]}
    raise DomainError(502, "供应商未返回图片结果")


async def download_image(
    transport: ProviderTransport,
    url: str,
    base_url: str,
    maximum: int,
) -> bytes:
    """下载只读取已有结果，不重新生成；无凭据、固定 IP、有大小上限。"""
    proxy_dns = False
    if "token-plan.cn-beijing.maas.aliyuncs.com" in base_url:
        origin = bailian_origin(base_url)
        url, proxy_dns = bailian_download(url, origin, transport.allowed_origins)
    result = bytearray()
    async with transport.open_stream("GET", url, {}, allow_proxy_dns=proxy_dns) as response:
        async for chunk in response.aiter_bytes():
            result.extend(chunk)
            if len(result) > maximum:
                raise DomainError(502, "图片文件超过处理上限")
    return bytes(result)
