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
from app.modules.models.service.image_protocol import download_image, image_request, image_result
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
        endpoint, body = image_request(
            connection["adapter"],
            configuration["modelId"],
            configuration["parameters"],
            prompt,
            images,
            connection["baseUrl"],
        )
        response = await self.transport.request(
            "POST",
            endpoint,
            {"Authorization": "Bearer " + self.resolved["apiKey"]},
            body,
            # 参考图编辑通常比文字生图更慢，延长单次等待而非自动重提收费请求。
            read_timeout=240,
        )
        receipt.parent.mkdir(parents=True, exist_ok=True)
        temporary = receipt.with_suffix(".tmp")
        await asyncio.to_thread(temporary.write_text, json.dumps(response), encoding="utf-8")
        await asyncio.to_thread(temporary.replace, receipt)

    async def result(self, receipt: Path, destination: Path) -> None:
        value = json.loads(await asyncio.to_thread(receipt.read_text, encoding="utf-8"))
        item = image_result(value)
        if isinstance(item.get("b64_json"), str):
            try:
                content = base64.b64decode(item["b64_json"], validate=True)
            except (ValueError, binascii.Error) as error:
                raise DomainError(502, "图片编码无效") from error
        elif isinstance(item.get("url"), str):
            content = await download_image(
                self.transport,
                item["url"],
                self.resolved["connection"]["baseUrl"],
                24 * 1024 * 1024,
            )
        else:
            raise DomainError(502, "供应商未返回可读取的图片")
        normalized = await asyncio.to_thread(normalized_image, content)
        temporary = destination.with_suffix(".tmp")
        await asyncio.to_thread(temporary.write_bytes, normalized)
        await asyncio.to_thread(temporary.replace, destination)
