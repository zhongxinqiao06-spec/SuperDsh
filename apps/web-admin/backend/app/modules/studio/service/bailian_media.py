"""百炼媒体适配器。模型来自已授权配置，任务回执和媒体下载分别处理。"""

import asyncio
import re
from functools import cache
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport

ProtocolPath = Annotated[str, Field(pattern=r"^/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+$")]


class BailianRoutes(BaseModel):
    """随部署发布的媒体协议相对路径，只能追加到已校验的百炼域名。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    video: ProtocolPath
    tasks: ProtocolPath
    speech: ProtocolPath


@cache
def _routes() -> BailianRoutes:
    path = Path(__file__).resolve().parents[4] / "resources/providers/bailian-media.json"
    return BailianRoutes.model_validate_json(path.read_bytes())


class BailianMedia:
    """同一供应商连接可同时承载聊天、异步视频和同步语音。"""

    def __init__(self, transport: ProviderTransport, base_url: str, key: str, model: str) -> None:
        endpoint = urlsplit(base_url)
        if (endpoint.scheme, endpoint.netloc) != (
            "https",
            "token-plan.cn-beijing.maas.aliyuncs.com",
        ):
            raise DomainError(422, "所选连接未接入百炼 Token Plan 媒体协议")
        self.transport = transport
        self.origin = f"{endpoint.scheme}://{endpoint.netloc}"
        self.routes = _routes()
        self.headers = {"Authorization": f"Bearer {key}"}
        self.model = model

    async def video(
        self,
        prompt: str,
        seconds: int,
        references: list[str] | None = None,
        *,
        aspect: str = "16:9",
        resolution: str = "720P",
    ) -> str:
        """只提交一次，调用者须先落库再请求，并立即保存供应商任务号。"""
        inputs: dict[str, object] = {"prompt": prompt}
        if references:
            inputs["media"] = [{"type": "reference_image", "url": ref} for ref in references]
        result = await self.transport.request(
            "POST",
            self.origin + self.routes.video,
            {**self.headers, "X-DashScope-Async": "enable"},
            {
                "model": self.model,
                "input": inputs,
                "parameters": {"duration": seconds, "resolution": resolution, "ratio": aspect},
            },
        )
        output = result.get("output")
        task = output.get("task_id") if isinstance(output, dict) else None
        if not isinstance(task, str) or not re.fullmatch(r"[\w-]{1,128}", task):
            raise DomainError(502, "百炼未返回可核对的任务号")
        return task

    async def status(self, task: str) -> tuple[str, str]:
        """轮询仅使用服务器保存的任务号，签名下载地址不得返回给浏览器。"""
        if not re.fullmatch(r"[\w-]{1,128}", task):
            raise DomainError(422, "供应商任务号无效")
        result = await self.transport.request(
            "GET", self.origin + self.routes.tasks + "/" + task, self.headers
        )
        output = result.get("output")
        if not isinstance(output, dict):
            raise DomainError(502, "百炼任务响应无效")
        return str(output.get("task_status", "UNKNOWN")), str(output.get("video_url") or "")

    async def speech(self, text: str, voice: str) -> str:
        result = await self.transport.request(
            "POST",
            self.origin + self.routes.speech,
            self.headers,
            {
                "model": self.model,
                "input": {"text": text, "voice": voice, "format": "wav", "sample_rate": 22050},
            },
        )
        output = result.get("output")
        audio = output.get("audio") if isinstance(output, dict) else None
        if not isinstance(audio, dict) or not isinstance(audio.get("url"), str):
            raise DomainError(502, "百炼未返回配音地址")
        return str(audio["url"])

    async def cancel(self, task: str) -> str:
        """只有远端明确返回取消状态，才算取消成功。"""
        if not re.fullmatch(r"[\w-]{1,128}", task):
            raise DomainError(422, "供应商任务号无效")
        await self.transport.request(
            "POST", self.origin + self.routes.tasks + "/" + task + "/cancel", self.headers, {}
        )
        status, _ = await self.status(task)
        return status

    async def download(self, url: str, destination: Path) -> None:
        """下载使用独立无凭据连接和临时文件，完整接收后原子替换。"""
        parts = urlsplit(url)
        # 百炼配音可能返回 HTTP 的 OSS 签名；仅在官方 OSS 域名升级为 TLS。
        if parts.scheme == "http" and parts.netloc.endswith(".aliyuncs.com"):
            url = parts._replace(scheme="https").geturl()
        if urlsplit(url).scheme != "https":
            raise DomainError(502, "媒体下载地址无效")
        # 百炼为每次生成分配 OSS 分桶。仅允许显式信任的百炼连接在服务商分桶使用代理的合成网段；
        # 下载仍固定 IP、校验原域名 TLS、不跟随重定向，普通内网和回环地址仍被拒绝。
        download_origin = urlsplit(url).netloc
        proxy_dns = self.origin in self.transport.allowed_origins and bool(
            re.fullmatch(
                r"dashscope-[a-z0-9-]+\.oss-(?:accelerate|cn-[a-z0-9-]+)\.aliyuncs\.com",
                download_origin,
            )
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_suffix(".part")
        size = 0
        try:
            async with (
                asyncio.timeout(180),
                self.transport.open_stream("GET", url, {}, allow_proxy_dns=proxy_dns) as response,
            ):
                with partial.open("wb") as target:
                    async for chunk in response.aiter_bytes(256 * 1024):
                        size += len(chunk)
                        if size > 512 * 1024 * 1024:
                            raise DomainError(413, "媒体文件超过单项大小限制")
                        await asyncio.to_thread(target.write, chunk)
            if not size:
                raise DomainError(502, "供应商返回空文件")
            partial.replace(destination)
        finally:
            partial.unlink(missing_ok=True)
