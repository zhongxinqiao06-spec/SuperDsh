"""跨产品参考资料 AI 用例；复用模型授权、供应商传输及不可重放的收费收据。"""

import asyncio
import contextlib
import hashlib
import json
from typing import cast

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.product_roles import Product
from app.modules.identity.service.identity import IdentityService
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.models.service.capabilities import validate_parameters
from app.modules.models.service.configuration_service import ConfigurationService
from app.modules.models.service.model_operation_service import ModelOperationService
from app.modules.models.service.reference_protocol import (
    encode_images,
    object_value,
    research_answer,
    search_request,
    vision_answer,
    vision_request,
)
from app.modules.models.service.reference_response import reference_response


class ReferenceAnalysisService:
    """调用方先授权业务 scope 和图片；本服务始终复验账号、产品和冻结模型修订。"""

    def __init__(
        self,
        configurations: ConfigurationService,
        operations: ModelOperationService,
        identity: IdentityService,
    ) -> None:
        self.configurations, self.operations, self.identity = configurations, operations, identity

    async def _current(self, account: Account) -> Account:
        current = await self.identity.get_account(account.user_id)
        if current.auth_version != account.auth_version:
            raise DomainError(403, "账号授权已变化，请重新进入")
        return current

    async def inspect(self, account: Account, product: Product) -> dict[str, dict[str, object]]:
        """仅检查产品默认目录和冻结修订，不调用供应商，不返回凭据或连接地址。"""
        current = await self._current(account)
        catalog = await self.configurations.catalog(current, product)
        defaults = catalog.get("defaults")
        configurations = catalog.get("configurations")
        rows = (
            [object_value(row) for row in configurations]
            if isinstance(configurations, list)
            else []
        )
        choices = [object_value(row) for row in defaults] if isinstance(defaults, list) else []
        result: dict[str, dict[str, object]] = {}
        for key, capability in (("vision", "vision.analyze"), ("research", "web.search")):
            default = next((row for row in choices if row.get("capability") == capability), {})
            selected = next(
                (
                    row
                    for row in rows
                    if row.get("id") == default.get("configurationId")
                    and row.get("capability") == capability
                ),
                None,
            )
            if selected is None:
                result[key] = {
                    "available": False,
                    "binding": None,
                    "name": "",
                    "maxImages": 0,
                    "reason": "请在当前产品设置此能力的默认模型",
                }
                continue
            binding = CapabilityBinding.model_validate(
                {
                    "configurationId": selected["id"],
                    "revision": selected["revision"],
                    "capability": capability,
                }
            )
            try:
                resolved = await self.configurations.resolve(current, binding, product)
                configuration = object_value(resolved.get("configuration"))
                connection = object_value(resolved.get("connection"))
                parameters = validate_parameters(
                    str(connection.get("adapter")),
                    capability,
                    str(configuration.get("modelId")),
                    object_value(configuration.get("parameters")),
                    str(connection.get("baseUrl")),
                )
            except DomainError as error:
                if error.status >= 500:
                    raise
                result[key] = {
                    "available": False,
                    "binding": None,
                    "name": str(selected.get("name", "")),
                    "maxImages": 0,
                    "reason": error.detail,
                }
                continue
            result[key] = {
                "available": True,
                "binding": binding.model_dump(),
                "name": str(configuration.get("name", "")),
                "maxImages": parameters.get("maxImages", 0),
            }
        return result

    async def analyze(
        self,
        account: Account,
        product: Product,
        scope: str,
        key: str,
        binding: CapabilityBinding,
        prompt: str,
        images: list[tuple[bytes, str]],
    ) -> dict[str, object]:
        """分析已获业务授权的图片，返回正文；保持操作幂等，未知提交不重放。"""
        if binding.capability != "vision.analyze":
            raise DomainError(422, "请选择视觉分析配置")
        return await self._execute(account, product, scope, key, binding, prompt, images)

    async def search(
        self,
        account: Account,
        product: Product,
        scope: str,
        key: str,
        binding: CapabilityBinding,
        query: str,
    ) -> dict[str, object]:
        """检索公开资料，只发布包含供应商真实结构化引用的结果。"""
        if binding.capability != "web.search":
            raise DomainError(422, "请选择联网资料查询配置")
        return await self._execute(account, product, scope, key, binding, query, [])

    async def _execute(
        self,
        account: Account,
        product: Product,
        scope: str,
        key: str,
        binding: CapabilityBinding,
        prompt: str,
        images: list[tuple[bytes, str]],
    ) -> dict[str, object]:
        async def authorize() -> tuple[Account, dict[str, object]]:
            current = await self._current(account)
            return current, await self.configurations.resolve(current, binding, product)

        current, resolved = await authorize()
        configuration = object_value(resolved.get("configuration"))
        connection = object_value(resolved.get("connection"))
        adapter, model = str(connection.get("adapter")), str(configuration.get("modelId"))
        parameters = validate_parameters(
            adapter,
            binding.capability,
            model,
            object_value(configuration.get("parameters")),
            str(connection.get("baseUrl")),
        )
        if binding.capability == "vision.analyze":
            encoded = await asyncio.to_thread(
                encode_images, images, int(cast(int, parameters.get("maxImages", 4)))
            )
            endpoint, body = vision_request(adapter, model, parameters, prompt, encoded)
        else:
            endpoint, body = search_request(adapter, model, parameters, prompt)
        digest = hashlib.sha256(
            json.dumps(
                {
                    "product": product,
                    "binding": binding.model_dump(),
                    "body": body,
                },
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        # 参考图、提示词和冻结修订不变时可复用已完成识图；联网查询有时效性，不能跨请求缓存。
        cached = (
            await self.operations.completed_result(current, scope, binding, digest)
            if binding.capability == "vision.analyze"
            else None
        )
        claim = await self.operations.claim(current, scope, key, binding, digest)
        if claim.state == "completed":
            return dict(claim.result)
        receipt, submitted, terminal_error = claim.receipt, claim.receipt is not None, False
        parent, revoked = asyncio.current_task(), False

        async def monitor() -> None:
            nonlocal revoked
            while True:
                await asyncio.sleep(1)
                try:
                    await authorize()
                    await self.operations.update(claim)
                except Exception:
                    revoked = True
                    if parent:
                        parent.cancel()
                    return

        watcher = asyncio.create_task(monitor())
        try:
            async with asyncio.timeout(300 if binding.capability == "web.search" else 240):
                if cached is not None:
                    # 新操作号也保留幂等约束；旧未知操作号仍由 claim 拒绝，不能借缓存篡改其状态。
                    await authorize()
                    await self.operations.update(
                        claim, state="completed", result=cached, release=True
                    )
                    return cached
                if receipt is None:
                    await authorize()
                    await self.operations.update(claim)
                    submitted = True
                    async with self.configurations.transport.open_stream(
                        "POST",
                        str(connection["baseUrl"]).rstrip("/") + endpoint,
                        {
                            "Authorization": "Bearer " + str(resolved["apiKey"]),
                            "Content-Type": "application/json",
                        },
                        body,
                        preserve_status=True,
                        read_timeout=180 if binding.capability == "web.search" else 60,
                    ) as response:
                        request_id = response.headers.get(
                            "x-request-id", response.headers.get("x-tt-logid", "")
                        )
                        if request_id:
                            await self.operations.update(claim, request_id=request_id)

                        async def record_response_id(value: str) -> None:
                            # 尽早留存响应标识；即使后续断流也能人工核对，但不能用半截响应重放请求。
                            nonlocal request_id
                            request_id = value
                            await self.operations.update(claim, request_id=value)

                        value = await reference_response(
                            response,
                            streaming=body.get("stream") is True,
                            record_response_id=record_response_id,
                        )
                    receipt = value
                    await self.operations.update(
                        claim, state="result-pending", receipt=value, request_id=request_id
                    )
                try:
                    result: dict[str, object] = (
                        research_answer(receipt)
                        if binding.capability == "web.search"
                        else {"text": vision_answer(receipt), "sources": []}
                    )
                except DomainError:
                    terminal_error = True
                    raise
                result.update({"operationId": claim.identifier, "binding": binding.model_dump()})
                await authorize()
                await self.operations.update(
                    claim,
                    state="completed",
                    result=result,
                    usage=object_value(receipt.get("usage")),
                    release=True,
                )
                return result
        except (Exception, asyncio.CancelledError) as error:
            # 供应商收据已持久化时只恢复本地解析；请求受理未知时绝不再次发起收费 POST。
            state = (
                "failed"
                if not submitted
                or terminal_error
                or isinstance(error, DomainError)
                and 400 <= error.status < 500
                and error.status != 403
                else "cancel-requested"
                if isinstance(error, asyncio.CancelledError)
                else "timed-out"
                if isinstance(error, TimeoutError)
                or isinstance(error, DomainError)
                and error.status == 504
                else "result-pending"
                if receipt is not None
                else "submission-unknown"
            )
            with contextlib.suppress(DomainError):
                await asyncio.shield(
                    self.operations.update(
                        claim,
                        state=state,
                        error="操作未自动重试，请按供应商请求记录核对结果",
                        release=True,
                    )
                )
            if revoked:
                raise DomainError(403, "账号、模型授权或执行租约已失效") from error
            if (
                isinstance(error, TimeoutError)
                or isinstance(error, DomainError)
                and error.status == 504
            ):
                label = "联网" if binding.capability == "web.search" else "图像分析"
                raise DomainError(
                    504,
                    f"等待{label}结果超时，状态待核对；未自动重试，请先核对供应商请求记录",
                    "provider_operation_pending",
                ) from error
            raise
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher
