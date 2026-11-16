"""图片能力适配：读取已授权模型配置，保存收据后只重试结果传输。"""

import asyncio
import base64
import binascii
import io
import json
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport


def normalized_image(content: bytes) -> bytes:
    """校验实际像素并转为 PNG，禁止仅凭扩展名发布供应商输出。"""
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.width * image.height > 32_000_000 or image.width < 1 or image.height < 1:
                raise DomainError(502, "图片像素超出限制")
            image.load()
            output = io.BytesIO()
            image.convert("RGB").save(output, "PNG")
            return output.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise DomainError(502, "生成结果不是有效图片") from error


class ImageProvider:
    def __init__(self, transport: ProviderTransport, resolved: dict[str, Any]) -> None:
        self.transport, self.resolved = transport, resolved

    async def generate(self, prompt: str, images: list[str], receipt: Path) -> None:
        """只调用一次收费接口；一旦取得结果先原子写入私有收据，再处理文件。"""
        connection, configuration = self.resolved["connection"], self.resolved["configuration"]
        adapter = connection["adapter"]
        if adapter not in {"openai-completions", "volcengine-ark"}:
            raise DomainError(422, "当前连接尚未接入图片能力")
        if images and adapter != "volcengine-ark":
            raise DomainError(422, "当前连接不支持参考图编辑")
        body: dict[str, object] = {
            "model": configuration["modelId"],
            "prompt": prompt,
            "size": configuration["parameters"]["size"],
            "response_format": "b64_json",
        }
        body.update({"watermark": True} if adapter == "volcengine-ark" else {"n": 1})
        if images:
            body["image"] = images[0] if len(images) == 1 else images
        response = await self.transport.request(
            "POST",
            connection["baseUrl"].rstrip("/") + "/images/generations",
            {"Authorization": "Bearer " + self.resolved["apiKey"]},
            body,
        )
        receipt.parent.mkdir(parents=True, exist_ok=True)
        temporary = receipt.with_suffix(".tmp")
        await asyncio.to_thread(temporary.write_text, json.dumps(response), encoding="utf-8")
        await asyncio.to_thread(temporary.replace, receipt)

    async def result(self, receipt: Path, destination: Path) -> None:
        value = json.loads(await asyncio.to_thread(receipt.read_text, encoding="utf-8"))
        data = value.get("data")
        item = data[0] if isinstance(data, list) and data else None
        if not isinstance(item, dict):
            raise DomainError(502, "供应商未返回图片结果")
        if isinstance(item.get("b64_json"), str):
            try:
                content = base64.b64decode(item["b64_json"], validate=True)
            except (ValueError, binascii.Error) as error:
                raise DomainError(502, "图片编码无效") from error
        elif isinstance(item.get("url"), str):
            result = bytearray()
            async with self.transport.open_stream("GET", item["url"], {}) as response:
                async for block in response.aiter_bytes():
                    result.extend(block)
                    if len(result) > 24 * 1024 * 1024:
                        raise DomainError(502, "图片文件超过处理上限")
            content = bytes(result)
        else:
            raise DomainError(502, "供应商未返回可读取的图片")
        normalized = await asyncio.to_thread(normalized_image, content)
        temporary = destination.with_suffix(".tmp")
        await asyncio.to_thread(temporary.write_bytes, normalized)
        await asyncio.to_thread(temporary.replace, destination)
