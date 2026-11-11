"""模型代理复用真实供应商配置，DSH与远程设备都须通过实时授权。"""

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator

from app.infrastructure.errors import DomainError
from app.integrations.dsh.protocol import fields
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.identity import IdentityService
from app.modules.models.service.model_service import ModelService
from app.modules.runtime.entity.bo.values import Fields


class ModelProxyService:
    """只转发已声明协议路径，绝不接收浏览器提供的上游URL或密钥。"""

    def __init__(
        self, models: ModelService, identity: IdentityService, devices: DeviceService
    ) -> None:
        self.models, self.identity, self.devices = models, identity, devices

    async def catalog(self, owner: str) -> Fields:
        """固定引擎的回环能力只获取脱敏目录。"""
        return fields(await self.models.catalog(await self.identity.get_account(owner)))

    async def connector(self, token: str) -> tuple[Account, dict[str, object]]:
        """Connector令牌先解析主体，再检查账号和模型权限。"""
        principal = await self.devices.model_principal(token)
        account = await self.identity.get_account(str(principal["userId"]))
        await self.devices.authorize_models(
            account, str(principal["id"]), str(principal["tokenHash"])
        )
        return account, principal

    async def stream(self, owner: str, path: str, body: Fields) -> AsyncIterator[bytes]:
        """满足固定DSH ModelProvider端口，不创建另一个模型执行循环。"""
        account = await self.identity.get_account(owner)
        parts = path.split("/")
        catalog = await self.models.catalog(account)
        if (
            len(parts) < 6
            or parts[0] != "scopes"
            or parts[1] != catalog["scope"]
            or parts[2] != "providers"
        ):
            raise DomainError(403, "模型目录作用域已失效")
        async for chunk in self.forward(
            account, parts[3], parts[4], "/".join(parts[5:]), dict(body)
        ):
            yield chunk

    async def forward(
        self,
        account: Account,
        provider: str,
        protocol: str,
        operation: str,
        body: dict[str, object],
        connector: str | None = None,
        fingerprint: str | None = None,
        protocol_headers: dict[str, str] | None = None,
        access_token: str | None = None,
    ) -> AsyncIterator[bytes]:
        """流式调用不自动重试；后台撤权检查会终止仍等待供应商的请求。"""
        allowed = {
            ("openai-completions", "chat/completions"),
            ("openai-responses", "responses"),
            ("anthropic-messages", "messages"),
            ("anthropic-messages", "v1/messages"),
        }
        if (protocol, operation) not in allowed:
            raise DomainError(404, "模型协议操作不存在")
        model_id = body.get("model")
        if not isinstance(model_id, str) or not model_id or body.get("background"):
            raise DomainError(422, "模型请求或配置无效")
        if len(json.dumps(body).encode()) > 8 * 1024 * 1024:
            raise DomainError(413, "模型请求过大")
        current = (
            await self.identity.authenticate(access_token)
            if access_token
            else await self.identity.get_account(account.user_id)
        )
        if current.auth_version != account.auth_version:
            raise DomainError(403, "账号授权已变化")
        if connector:
            await self.devices.authorize_models(current, connector, fingerprint)
        configuration = await self.models.resolve(current, provider, protocol, model_id)
        # 火山 Responses 的禁止存储约束来自已授权连接，不接受客户端覆盖。
        if configuration.get("forceNoStore") and protocol == "openai-responses":
            body = {**body, "store": False}
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if body.get("stream") is True else "application/json",
        }
        key = configuration.get("key")
        if protocol == "anthropic-messages":
            headers["anthropic-version"] = (protocol_headers or {}).get(
                "anthropic-version", "2023-06-01"
            )
            if (protocol_headers or {}).get("anthropic-beta"):
                headers["anthropic-beta"] = (
                    str(protocol_headers["anthropic-beta"]) if protocol_headers else ""
                )
            if key:
                headers["x-api-key"] = str(key)
        elif key:
            headers["Authorization"] = "Bearer " + str(key)
        parent = asyncio.current_task()
        revoked = False

        async def monitor() -> None:
            nonlocal revoked
            while True:
                await asyncio.sleep(1)
                try:
                    fresh = (
                        await self.identity.authenticate(access_token)
                        if access_token
                        else await self.identity.get_account(account.user_id)
                    )
                    if fresh.auth_version != account.auth_version:
                        raise DomainError(403, "账号授权已变化")
                    if connector:
                        await self.devices.authorize_models(fresh, connector, fingerprint)
                    await self.models.resolve(fresh, provider, protocol, model_id)
                except Exception:
                    revoked = True
                    if parent:
                        parent.cancel()
                    return

        watcher = asyncio.create_task(monitor())
        try:
            async with self.models.transport.open_stream(
                "POST",
                str(configuration["baseUrl"]).rstrip("/") + "/" + operation,
                headers,
                body,
                preserve_status=True,
            ) as response:
                total = 0
                upstream = response.aiter_bytes()
                while True:
                    if revoked:
                        raise DomainError(403, "模型或设备授权已撤销")
                    # HTTP首块预读与StreamingResponse可能属于不同任务，只取消当前等待者。
                    parent = asyncio.current_task()
                    try:
                        chunk = await anext(upstream)
                    except StopAsyncIteration:
                        break
                    total += len(chunk)
                    if total > 64 * 1024 * 1024:
                        raise DomainError(502, "模型响应超过允许大小")
                    parent = None
                    yield chunk
        except asyncio.CancelledError as error:
            if revoked:
                raise DomainError(403, "模型或设备授权已撤销") from error
            raise
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher
