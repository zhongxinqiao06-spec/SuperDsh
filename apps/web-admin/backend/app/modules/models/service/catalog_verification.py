"""共享只读连接检测：仅访问模型目录，不以生成请求替代缺失的目录接口。"""

import asyncio
import json
from datetime import UTC, datetime

from app.infrastructure.errors import DomainError
from app.modules.models.entity.vo.verification_vo import ModelVerification
from app.modules.models.service.provider_transport import ProviderTransport


async def verify_model_catalog(
    transport: ProviderTransport, url: str, headers: dict[str, str]
) -> ModelVerification:
    """目录 404/405 仅说明本次检测无法确认；不推断密钥无效或静默发起收费请求。"""
    try:
        # 整次只读检测有界完成，给页面请求超时留出错误响应时间。
        async with asyncio.timeout(25):
            async with transport.open_stream(
                "GET", url, {"Accept": "application/json", **headers}, preserve_status=True
            ) as response:
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > 16 * 1024 * 1024:
                        raise DomainError(502, "供应商模型目录数据过大")
                try:
                    value = json.loads(content)
                except (ValueError, UnicodeError) as error:
                    raise DomainError(502, "供应商模型目录格式无效") from error
                if not isinstance(value, dict) or not isinstance(value.get("data"), list):
                    raise DomainError(502, "供应商模型目录格式无效")
    except DomainError as error:
        if error.status in {404, 405}:
            return ModelVerification(
                ok=False,
                status="unverified",
                message=(
                    f"模型目录请求返回 HTTP {error.status}，无法通过只读检测确认凭据或模型可用性；"
                    "本次未发起模型生成。请核对供应商地址，或通过显式模型调用验证。"
                ),
                serverTime=datetime.now(UTC).isoformat(),
            )
        # 上游鉴权失败不是平台登录失效，不能触发客户端刷新或退出当前账号。
        if error.status == 401:
            raise DomainError(
                422, "供应商拒绝模型目录访问，请检查凭据", "model_catalog_rejected"
            ) from error
        raise
    except TimeoutError as error:
        raise DomainError(504, "供应商模型目录检测超时") from error
    return ModelVerification(
        ok=True,
        status="verified",
        message="模型目录可访问；未发起模型生成，具体模型调用能力尚未验证。",
        serverTime=datetime.now(UTC).isoformat(),
    )
