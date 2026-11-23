"""通过百炼官方 CLI 网关读取个人版月度用量，临时令牌只在本次查询内使用。"""

import json
from urllib.parse import urlencode

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport

TOKEN_PATH = "/modelstudio/cli/generateAccessToken"
USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"
GATEWAY_URL = "https://bailian-cs.console.aliyun.com/cli/api.json?" + urlencode(
    {"action": "BroadScopeAspnGateway", "product": "sfm_bailian", "api": USAGE_API}
)


def monthly_usage(payload: object) -> dict[str, object]:
    """只解包官方网关协议层；比例采用 0–1，重置时间为 Unix 毫秒。"""
    while isinstance(payload, dict):
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
    values = payload if isinstance(payload, dict) else {}
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
    params = {
        "Api": USAGE_API,
        "V": "1.0",
        "Data": {
            "cornerstoneParam": {
                "protocol": "V2",
                "console": "ONE_CONSOLE",
                "productCode": "p_efm",
                "switchUserType": 3,
                "consoleSite": "BAILIAN_ALIYUN",
            }
        },
    }
    body = urlencode({"params": json.dumps(params, separators=(",", ":")), "region": "cn-beijing"})
    result = await transport.request(
        "POST",
        GATEWAY_URL,
        {
            "Authorization": "Bearer " + token.strip(),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body.encode("ascii"),
    )
    return monthly_usage(result)
