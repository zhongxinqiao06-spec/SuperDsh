"""通过百炼官方 CLI 网关读取个人版月度用量，临时令牌只在本次查询内使用。"""

import asyncio
import json
from pathlib import Path
from urllib.parse import urlencode

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport

TOKEN_PATH = "/modelstudio/cli/generateAccessToken"
USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"
LOGIN_API = "zeldaEasy.cornerstone-portal.cs-console.loginInfo"


def _console_data(payload: object) -> dict[str, object]:
    while isinstance(payload, dict):
        code = payload.get("errorCode")
        if isinstance(code, str) and "NotLogined" in code:
            raise DomainError(401, "百炼 CLI 登录已失效，请用绑定的 RAM 账号重新授权")
        if payload.get("errorCode") == "BailianGateway.Team.NotAuthorised":
            raise DomainError(403, "请在百炼账号管理中给当前 RAM 用户授予所属组织的订阅套餐权限")
        if (
            payload.get("success") is False
            or payload.get("successResponse") is False
            or payload.get("failed") is True
            or payload.get("errorCode") not in (None, "", 0, "0", "200")
            or any(
                isinstance(entry, str) and not entry.startswith("SUCCESS::")
                for entry in (payload["ret"] if isinstance(payload.get("ret"), list) else [])
            )
        ):
            raise DomainError(502, "百炼个人版用量查询未成功")
        if "DataV2" in payload:
            payload = payload["DataV2"]
        elif "data" in payload:
            payload = payload["data"]
        else:
            break
    return payload if isinstance(payload, dict) else {}


def monthly_usage(payload: object) -> dict[str, object]:
    """解析官方月用量；比例采用 0–1，重置时间为 Unix 毫秒。"""
    values = _console_data(payload)
    ratio = values.get("per1MonthPercentage")
    reset = values.get("per1MonthResetTime")
    return {
        "usedRatio": ratio
        if isinstance(ratio, (int, float)) and not isinstance(ratio, bool) and 0 <= ratio <= 1
        else None,
        "resetAtMs": reset if type(reset) is int and 0 < reset <= 253402300799999 else None,
    }


async def personal_usage(
    transport: ProviderTransport, token_url: str, signed_headers: dict[str, str]
) -> dict[str, object]:
    """只向北京站固定用量接口发送临时令牌，不转发模型 Key 或 RAM 密钥。"""
    try:
        exchange = await transport.request("POST", token_url, signed_headers)
    except DomainError as error:
        if error.code == "provider_http_403":
            raise DomainError(
                403, "请核对 RAM 用户的 modelstudio:GenerateCLIAccessToken 权限"
            ) from error
        raise
    token = exchange.get("cliAccessToken")
    if not isinstance(token, str) or not token.strip():
        raise DomainError(502, "百炼未签发 CLI 访问令牌")
    return monthly_usage(await console_read(transport, USAGE_API, token.strip()))


async def console_read(
    transport: ProviderTransport, api: str, token: str, agent: int | None = None
) -> dict[str, object]:
    """向百炼北京站发起只读请求；仅使用官方登录返回的组织上下文。"""
    if api not in (LOGIN_API, USAGE_API):
        raise ValueError("未知百炼用量操作")
    url = "https://bailian-cs.console.aliyun.com/cli/api.json?" + urlencode(
        {"action": "BroadScopeAspnGateway", "product": "sfm_bailian", "api": api}
    )
    params = {
        "Api": api,
        "V": "1.0",
        "Data": {
            "cornerstoneParam": {
                "protocol": "V2",
                "console": "ONE_CONSOLE",
                "productCode": "p_efm",
                "switchUserType": 3,
                "consoleSite": "BAILIAN_ALIYUN",
                **({"switchAgent": agent} if agent is not None else {}),
            }
        },
    }
    body = urlencode({"params": json.dumps(params, separators=(",", ":")), "region": "cn-beijing"})
    try:
        return await transport.request(
            "POST",
            url,
            {
                "Authorization": "Bearer " + token.strip(),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body.encode("ascii"),
        )
    except DomainError as error:
        if error.code == "provider_http_401":
            raise DomainError(401, "百炼 CLI 登录已失效，请重新授权") from error
        raise


async def verified_cli_session(
    transport: ProviderTransport, directory: Path, user_id: str, owner_id: str
) -> tuple[str, int | None]:
    """同一次查询使用同一个 CLI 会话；以百炼返回的 RAM 身份校验订阅归属。"""
    try:
        raw = await asyncio.to_thread(
            (directory / "aliyun-personal-cli" / "config.json").read_text, encoding="utf-8"
        )
    except FileNotFoundError as error:
        raise DomainError(401, "等待绑定的 RAM 账号完成百炼 CLI 登录") from error
    profile = json.loads(raw)
    if not isinstance(profile, dict):
        raise DomainError(422, "百炼 CLI 登录配置无效")
    token = profile.get("access_token")
    if not isinstance(token, str) or not token.strip():
        raise DomainError(401, "等待绑定的 RAM 账号完成百炼 CLI 登录")
    if (
        profile.get("console_site", "domestic") != "domestic"
        or profile.get("console_region", "cn-beijing") != "cn-beijing"
    ):
        raise DomainError(422, "请使用百炼中国站北京地域的 CLI 登录")
    value = profile.get("console_switch_agent")
    agent = None
    if value is not None:
        if not str(value).isascii() or not str(value).isdigit() or len(str(value)) > 20:
            raise DomainError(422, "百炼 CLI 登录的组织信息无效")
        agent = int(value)
    identity = _console_data(await console_read(transport, LOGIN_API, token.strip(), agent)).get(
        "aliyun"
    )
    if (
        not isinstance(identity, dict)
        or str(identity.get("uid")) != user_id
        or str(identity.get("parentUid")) != owner_id
    ):
        raise DomainError(403, "当前 CLI 登录身份与绑定的 RAM 账号不符，请切换账号后重新授权")
    return token.strip(), agent
