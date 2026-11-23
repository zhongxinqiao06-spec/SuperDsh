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
from app.modules.models.service.aliyun_personal_usage import TOKEN_PATH, personal_usage
from app.modules.models.service.provider_transport import ProviderTransport

HOST = "modelstudio.cn-beijing.aliyuncs.com"
PATH = "/tokenplan/subscription/stats"
EMPTY_HASH = hashlib.sha256(b"").hexdigest()


def signed_headers(
    key_id: str, secret: str, *, method: str, path: str, action: str
) -> dict[str, str]:
    """按 ACS3 规范签署同一北京站管理域名的空正文请求。"""
    headers = {
        "host": HOST,
        "x-acs-action": action,
        "x-acs-content-sha256": EMPTY_HASH,
        "x-acs-date": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "x-acs-signature-nonce": uuid4().hex,
        "x-acs-version": "2026-02-10",
    }
    names = ";".join(sorted(headers))
    canonical = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    request = f"{method}\n{path}\n\n{canonical}\n{names}\n{EMPTY_HASH}"
    digest = hashlib.sha256(request.encode()).hexdigest()
    signature = hmac.new(secret.encode(), f"ACS3-HMAC-SHA256\n{digest}".encode(), hashlib.sha256)
    del headers["host"]  # HTTP 客户端填入 Host，避免固定 IP 时产生同名请求头。
    headers["Authorization"] = (
        f"ACS3-HMAC-SHA256 Credential={key_id},SignedHeaders={names},Signature={signature.hexdigest()}"
    )
    return headers


async def read_quota(
    transport: ProviderTransport, file: Path | None, connection_id: str
) -> dict[str, object]:
    """按绑定连接的订阅版本查询；旧配置延用席位统计。"""
    reply: dict[str, object] = {"quotaItems": [], "quotaError": ""}
    personal = False
    try:
        if file is None:
            return {**reply, "quotaError": "此连接尚未配置额度查询凭据"}
        config = json.loads(await asyncio.to_thread(file.read_text, encoding="utf-8"))
        if not isinstance(config, dict) or config.get("connectionId") != connection_id:
            return {**reply, "quotaError": "此连接尚未绑定额度查询凭据"}
        personal = config.get("edition") == "personal"
        if personal:
            reply["personalUsage"] = {"usedRatio": None, "resetAtMs": None}
        key_id, secret = config.get("accessKeyId"), config.get("accessKeySecret")
        if not isinstance(key_id, str) or not key_id or not isinstance(secret, str) or not secret:
            return {**reply, "quotaError": "额度查询凭据不完整"}
        async with asyncio.timeout(20):
            if personal:
                headers = signed_headers(
                    key_id, secret, method="POST", path=TOKEN_PATH, action="GenerateCLIAccessToken"
                )
                reply["personalUsage"] = await personal_usage(
                    transport, f"https://{HOST}{TOKEN_PATH}", headers
                )
                return reply
            headers = signed_headers(
                key_id, secret, method="GET", path=PATH, action="GetSubscriptionStats"
            )
            result = await transport.request("GET", f"https://{HOST}{PATH}", headers)
    except FileNotFoundError:
        return {**reply, "quotaError": "此连接尚未配置额度查询凭据"}
    except DomainError as error:
        detail = error.detail
        if not personal and error.code == "provider_http_403":
            detail = "请核对 RAM 用户的 modelstudio:GetSubscriptionStats 权限"
        return {**reply, "quotaError": f"阿里云额度查询失败：{detail}"}
    except (OSError, ValueError, TimeoutError):
        return {**reply, "quotaError": "额度配置或响应无法读取，请检查配置后重试"}
    data = result.get("Data")
    if (
        result.get("Success") is not True
        or not isinstance(data, dict)
        or not isinstance(data.get("Items"), list)
    ):
        return {**reply, "quotaError": "阿里云未返回有效的订阅席位统计"}
    rows = []
    for item in data["Items"]:
        if not isinstance(item, dict) or not isinstance(item.get("SeatType"), str):
            return {**reply, "quotaError": "阿里云席位统计格式异常"}
        values = [item.get(k) for k in ("SeatCredits", "SeatRemainingCredits")]
        if any(
            type(v) not in (int, float) or (isinstance(v, float) and not math.isfinite(v))
            for v in values
        ):
            return {**reply, "quotaError": "阿里云未返回有效的席位额度"}
        rows.append({"type": item["SeatType"], "quota": values[0], "remaining": values[1]})
    return {"quotaItems": rows, "quotaError": "" if rows else "阿里云未返回席位额度"}
