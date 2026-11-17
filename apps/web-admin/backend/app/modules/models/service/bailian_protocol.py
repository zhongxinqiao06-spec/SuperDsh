"""百炼媒体协议元数据与下载边界，供工具和制作任务共同使用。"""

import re
from functools import cache
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

from app.infrastructure.errors import DomainError

ProtocolPath = Annotated[str, Field(pattern=r"^/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+$")]


class BailianRoutes(BaseModel):
    """第三方版本路径属于外部契约，集中读取，业务路由不复制版本。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    video: ProtocolPath
    tasks: ProtocolPath
    speech: ProtocolPath
    image: ProtocolPath


@cache
def bailian_routes() -> BailianRoutes:
    path = Path(__file__).resolve().parents[4] / "resources/providers/bailian-media.json"
    return BailianRoutes.model_validate_json(path.read_bytes())


def bailian_origin(base_url: str) -> str:
    endpoint = urlsplit(base_url)
    if (
        (endpoint.scheme, endpoint.netloc) != ("https", "token-plan.cn-beijing.maas.aliyuncs.com")
        or endpoint.username
        or endpoint.password
    ):
        raise DomainError(422, "所选连接未接入百炼 Token Plan 媒体协议")
    return f"{endpoint.scheme}://{endpoint.netloc}"


def bailian_download(url: str, origin: str, allowed_origins: set[str]) -> tuple[str, bool]:
    """签名文件不带模型密钥；仅已信任的百炼连接允许官方 OSS 使用代理合成网段。"""
    parts = urlsplit(url)
    if parts.scheme == "http" and parts.netloc.endswith(".aliyuncs.com"):
        url = parts._replace(scheme="https").geturl()
    if urlsplit(url).scheme != "https":
        raise DomainError(502, "媒体下载地址无效")
    proxy_dns = origin in allowed_origins and bool(
        re.fullmatch(
            r"dashscope-[a-z0-9-]+\.oss-(?:accelerate|cn-[a-z0-9-]+)\.aliyuncs\.com",
            parts.netloc,
        )
    )
    return url, proxy_dns
