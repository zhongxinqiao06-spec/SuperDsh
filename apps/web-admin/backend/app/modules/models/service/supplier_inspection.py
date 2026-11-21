"""查询当前连接的上游只读目录和公开余额，局部失败独立呈现。"""

import asyncio
from datetime import UTC, datetime
from urllib.parse import urlsplit

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport


async def inspect_supplier(
    transport: ProviderTransport, url: str, adapter: str, key: str
) -> dict[str, object]:
    """只返回模型标识及金额白名单；余额和平台登记的配额分别展示。"""
    headers = (
        {"x-api-key": key, "anthropic-version": "2023-06-01"}
        if adapter == "anthropic-messages"
        else {"Authorization": "Bearer " + key}
    )

    async def read(endpoint: str) -> tuple[dict[str, object], str]:
        try:
            async with asyncio.timeout(25):
                return await transport.request("GET", endpoint, headers), ""
        except DomainError as error:
            if error.code in ("provider_http_404", "provider_http_405"):
                return {}, "当前接入地址未提供此只读接口"
            return {}, error.detail
        except (TimeoutError, ValueError):
            return {}, "上游响应超时或数据格式异常"

    address = urlsplit(url)
    balance_endpoint = address.scheme == "https" and address.netloc.lower() == "api.deepseek.com"
    catalog_call = read(url.rstrip("/") + "/models")
    if balance_endpoint:
        (catalog, model_error), (wallet, balance_error) = await asyncio.gather(
            catalog_call, read("https://api.deepseek.com/user/balance")
        )
    else:
        catalog, model_error = await catalog_call
        wallet, balance_error = {}, ""
    raw = catalog.get("data")
    if not model_error and not isinstance(raw, list):
        model_error = "目录未返回模型列表"
    models = (
        sorted(
            {
                item["id"]
                for item in raw
                if isinstance(item, dict)
                and isinstance(item.get("id"), str)
                and 0 < len(item["id"]) <= 200
            }
        )
        if isinstance(raw, list)
        else []
    )
    balances = []
    values = wallet.get("balance_infos")
    if isinstance(values, list):
        balances = [
            {"currency": item["currency"], "amount": item["total_balance"]}
            for item in values
            if isinstance(item, dict)
            and item.get("currency") in ("CNY", "USD")
            and isinstance(item.get("total_balance"), str)
        ]
    elif balance_endpoint and not balance_error:
        balance_error = "余额接口未返回预期数据"
    return {
        "models": models,
        "modelError": model_error,
        "balances": balances,
        "balanceError": balance_error,
        "checkedAt": datetime.now(UTC).isoformat(),
    }
