"""百炼 Token Plan 管理 OpenAPI；RAM 密钥仅用于固定订阅统计地址签名。"""

import asyncio
import hashlib
import hmac
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport

HOST = "modelstudio.cn-beijing.aliyuncs.com"
PATH = "/tokenplan/subscription/stats"
EMPTY_HASH = hashlib.sha256(b"").hexdigest()


def signed_headers(key_id: str, secret: str, date: str, nonce: str) -> dict[str, str]:
    """按 ACS3 规范签署固定 GET 路径及空查询；Host 与 TLS 固定到同一官方域名。"""
    headers = {
        "host": HOST,
        "x-acs-action": "GetSubscriptionStats",
        "x-acs-content-sha256": EMPTY_HASH,
        "x-acs-date": date,
        "x-acs-signature-nonce": nonce,
        "x-acs-version": "2026-02-10",
    }
    names = ";".join(sorted(headers))
    canonical = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    request = f"GET\n{PATH}\n\n{canonical}\n{names}\n{EMPTY_HASH}"
    digest = hashlib.sha256(request.encode()).hexdigest()
    signature = hmac.new(secret.encode(), f"ACS3-HMAC-SHA256\n{digest}".encode(), hashlib.sha256)
    del headers["host"]  # HTTP 客户端填入 Host，避免固定 IP 时产生同名请求头。
    headers["Authorization"] = (
        f"ACS3-HMAC-SHA256 Credential={key_id},SignedHeaders={names},Signature={signature.hexdigest()}"
    )
    return headers


async def read_quota(
    transport: ProviderTransport, file: Path | None, connection_id: str
) -> tuple[list[dict[str, object]], str]:
    """只展示绑定连接的席位额度；空数据、权限不足和零余额分别呈现。"""
    try:
        if file is None:
            return [], "此连接尚未配置额度查询凭据"
        config = json.loads(await asyncio.to_thread(file.read_text, encoding="utf-8"))
        if not isinstance(config, dict) or config.get("connectionId") != connection_id:
            return [], "此连接尚未绑定额度查询凭据"
        key_id, secret = config.get("accessKeyId"), config.get("accessKeySecret")
        if not isinstance(key_id, str) or not key_id or not isinstance(secret, str) or not secret:
            return [], "额度查询凭据不完整"
        headers = signed_headers(
            key_id, secret, datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), uuid4().hex
        )
        async with asyncio.timeout(20):
            result = await transport.request("GET", f"https://{HOST}{PATH}", headers)
    except FileNotFoundError:
        return [], "此连接尚未配置额度查询凭据"
    except DomainError as error:
        if error.code == "provider_http_403":
            return (
                [],
                "阿里云拒绝额度查询（HTTP 403），请核对 RAM 用户的 modelstudio:GetSubscriptionStats 权限",
            )
        return [], f"阿里云额度查询失败：{error.detail}"
    except (OSError, ValueError, TimeoutError):
        return [], "额度配置或响应无法读取，请检查配置后重试"
    data = result.get("Data")
    if (
        result.get("Success") is not True
        or not isinstance(data, dict)
        or not isinstance(data.get("Items"), list)
    ):
        return [], "阿里云未返回有效的订阅席位统计"
    rows = []
    for item in data["Items"]:
        if not isinstance(item, dict) or not isinstance(item.get("SeatType"), str):
            return [], "阿里云席位统计格式异常"
        values = [item.get(k) for k in ("SeatCredits", "SeatRemainingCredits")]
        if any(
            type(v) not in (int, float) or (isinstance(v, float) and not math.isfinite(v))
            for v in values
        ):
            return [], "阿里云未返回有效的席位额度"
        rows.append({"type": item["SeatType"], "quota": values[0], "remaining": values[1]})
    return rows, "" if rows else "阿里云未返回席位额度；个人套餐可在百炼「我的订阅」核对"
