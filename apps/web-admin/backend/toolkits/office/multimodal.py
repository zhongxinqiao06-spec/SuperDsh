"""可配置生图与视觉工具；冻结费用来源、短租约收据与真实图片校验。"""

import asyncio
import base64
import binascii
import contextlib
import hashlib
import json
import re
from collections.abc import Awaitable, Callable

import httpx

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.models.service.configuration_service import ConfigurationService
from app.modules.models.service.model_operation_service import ModelOperationService, OperationClaim
from toolkits.office.contracts import Artifact, InputFile, record
from toolkits.office.images import image_data
from toolkits.office.multimodal_protocol import prepared_plan, request_body, vision_answer

SaveImage = Callable[[Account, str, str, Artifact], Awaitable[dict[str, object]]]
AuthorizeSession = Callable[[Account, str], Awaitable[object]]
GetAccount = Callable[[str], Awaitable[Account]]


async def response_bytes(response: httpx.Response, maximum: int = 32 * 1024 * 1024) -> bytes:
    """读取上限覆盖缺失或伪造Content-Length，取消由外层关闭连接。"""
    result = bytearray()
    async for chunk in response.aiter_bytes():
        result.extend(chunk)
        if len(result) > maximum:
            raise DomainError(502, "供应商响应超过处理上限")
    return bytes(result)


class MultimodalService:
    """仅实现可配置工具能力，不选择Agent、不建立模型循环或备用供应商。"""

    def __init__(
        self,
        configurations: ConfigurationService,
        operations: ModelOperationService,
        get_account: GetAccount,
        authorize_session: AuthorizeSession,
        save_image: SaveImage,
    ) -> None:
        self.configurations, self.operations = configurations, operations
        self.get_account, self.authorize_session, self.save_image = (
            get_account,
            authorize_session,
            save_image,
        )

    async def authorize(
        self,
        account: Account,
        session_id: str,
        binding: CapabilityBinding,
    ) -> tuple[Account, dict[str, object]]:
        """当前账号/会话和冻结模型修订都有效才可继续执行或发布结果。"""
        if binding.capability not in {"image.generate", "vision.analyze"}:
            raise DomainError(422, "此工具不支持所选模型能力")
        current = await self.get_account(account.user_id)
        if current.auth_version != account.auth_version:
            raise DomainError(403, "账号授权已变化")
        await self.authorize_session(current, session_id)
        return current, await self.configurations.resolve(current, binding)

    async def inspect(
        self,
        account: Account,
        session_id: str,
        binding: CapabilityBinding,
    ) -> dict[str, object]:
        """检查只读配置，不访问供应商生成接口。"""
        _, resolved = await self.authorize(account, session_id, binding)
        configuration = record(resolved["configuration"], "模型配置")
        parameters = record(configuration.get("parameters", {}), "模型参数")
        return {
            "configured": True,
            "model": configuration["name"],
            "parameters": parameters,
            "referenceImageLimit": parameters.get("maxImages", 4),
            "note": "参考图只能来自已授权资料；生成一次一张，视觉正文不等于审美质量验收。",
        }

    async def prepare(
        self,
        account: Account,
        session_id: str,
        binding: CapabilityBinding,
        plan: dict[str, object],
        images: list[InputFile],
    ) -> dict[str, object]:
        """在确认前完整校验参数与图片，执行时仍以同一方案摘要和修订复验。"""
        _, resolved = await self.authorize(account, session_id, binding)
        configuration = record(resolved["configuration"], "模型配置")
        document = prepared_plan(binding, plan, configuration)
        await asyncio.to_thread(request_body, binding, resolved, document, images)
        return {
            "document": document,
            "preflight": {
                "diagnostics": [
                    f"将使用 {configuration['name']} 执行{'单张配图生成' if binding.capability == 'image.generate' else '视觉理解'}；可能产生费用，不会自动重试或切换供应商。"
                ]
            },
        }

    async def execute(
        self,
        account: Account,
        session_id: str,
        binding: CapabilityBinding,
        call_id: str,
        plan: dict[str, object],
        images: list[InputFile],
    ) -> dict[str, object]:
        """执行先写幂等收据；重复请求只返回已完成结果或继续保存已收到的结果。"""
        current, resolved = await self.authorize(account, session_id, binding)
        if plan.get("capabilityBinding") != binding.model_dump():
            raise DomainError(409, "方案绑定的模型版本与会话不一致，请重新确认")
        document = prepared_plan(binding, plan, record(resolved["configuration"], "模型配置"))
        endpoint, body = await asyncio.to_thread(request_body, binding, resolved, document, images)
        digest = hashlib.sha256(
            json.dumps(
                {
                    "binding": binding.model_dump(),
                    "input": document,
                    "images": [source.sha256 for source in images],
                },
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        claim = await self.operations.claim(current, session_id, call_id, binding, digest)
        if claim.state == "completed":
            return dict(claim.result)
        submitted = claim.receipt is not None
        receipt = claim.receipt
        terminal_result_error = False
        revoked: DomainError | None = None
        parent = asyncio.current_task()

        async def monitor() -> None:
            nonlocal revoked
            while True:
                await asyncio.sleep(1)
                try:
                    await self.authorize(account, session_id, binding)
                    await self.operations.update(claim)
                except Exception:
                    revoked = DomainError(403, "会话、模型授权或执行租约已失效")
                    if parent:
                        parent.cancel()
                    return

        watcher = asyncio.create_task(monitor())
        try:
            async with asyncio.timeout(240):
                if receipt is None:
                    connection = record(resolved["connection"], "模型连接")
                    await self.authorize(account, session_id, binding)
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
                    ) as response:
                        request_id = response.headers.get(
                            "x-request-id", response.headers.get("x-tt-logid", "")
                        )
                        raw = await response_bytes(response)
                    try:
                        value = json.loads(raw)
                        if not isinstance(value, dict):
                            raise ValueError("not an object")
                    except (ValueError, UnicodeError) as error:
                        raise DomainError(502, "供应商返回的数据格式无效") from error
                    receipt = value
                    await self.operations.update(
                        claim,
                        state="result-pending",
                        receipt=value,
                        request_id=request_id,
                    )
                usage = receipt.get("usage")
                usage = dict(usage) if isinstance(usage, dict) else {}
                if binding.capability == "vision.analyze":
                    try:
                        answer = vision_answer(receipt)
                    except DomainError:
                        terminal_result_error = True
                        raise
                    result: dict[str, object] = {
                        "operationId": claim.identifier,
                        "text": answer,
                        "usage": usage,
                    }
                else:
                    result = await self.save_result(
                        account,
                        session_id,
                        binding,
                        claim,
                        document,
                        receipt,
                        usage,
                    )
                await self.authorize(account, session_id, binding)
                await self.operations.update(
                    claim, state="completed", result=result, usage=usage, release=True
                )
                return result
        except (Exception, asyncio.CancelledError) as error:
            # 已提交但未取到结果无法推断是否收费；已保存的收据只可重做结果传输。
            state = (
                "failed"
                if not submitted
                or terminal_result_error
                or isinstance(error, DomainError)
                and 400 <= error.status < 500
                and error.status != 403
                else "cancel-requested"
                if isinstance(error, asyncio.CancelledError)
                else "timed-out"
                if isinstance(error, TimeoutError)
                else "result-pending"
                if receipt is not None
                else "submission-unknown"
            )
            try:
                await asyncio.shield(
                    self.operations.update(
                        claim,
                        state=state,
                        error="操作未自动重试，请按供应商请求记录核对结果",
                        release=True,
                    )
                )
            except DomainError:
                # 失去租约的执行者不能覆盖持久状态；原异常仍向调用者传播。
                pass
            if revoked:
                raise revoked from error
            if isinstance(error, TimeoutError):
                raise DomainError(504, "供应商调用超时，提交状态需要核对；未自动重试") from error
            raise
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher

    async def save_result(
        self,
        account: Account,
        session_id: str,
        binding: CapabilityBinding,
        claim: OperationClaim,
        plan: dict[str, object],
        receipt: dict[str, object],
        usage: dict[str, object],
    ) -> dict[str, object]:
        """图片下载不带供应商凭据，保存前再次授权并校验真实像素内容。"""
        data = receipt.get("data")
        item = data[0] if isinstance(data, list) and data else None
        if not isinstance(item, dict):
            raise DomainError(502, "供应商未返回图片")
        if isinstance(item.get("b64_json"), str):
            encoded = item["b64_json"]
            if len(encoded) > 24 * 1024 * 1024:
                raise DomainError(502, "供应商图片编码过大")
            try:
                content = base64.b64decode(encoded, validate=True)
                if base64.b64encode(content).decode() != encoded:
                    raise ValueError("non canonical image")
            except (ValueError, binascii.Error) as error:
                raise DomainError(502, "供应商图片编码无效") from error
        elif isinstance(item.get("url"), str) and len(item["url"]) <= 4096:
            async with self.configurations.transport.open_stream(
                "GET", item["url"], {}
            ) as response:
                content = await response_bytes(response, 10 * 1024 * 1024)
        else:
            raise DomainError(502, "供应商未返回支持的图片内容")
        try:
            normalized, width, height = await asyncio.to_thread(
                image_data,
                InputFile("generated-image", content),
            )
        except DomainError as error:
            raise DomainError(502, "供应商返回的图片无法解码或超过限制") from error
        filename = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(plan["title"]))[:100] + ".png"
        current, _ = await self.authorize(account, session_id, binding)
        await self.operations.update(claim)
        artifact = Artifact(
            filename,
            normalized,
            "image/png",
            {"width": width, "height": height},
            {
                "operationId": claim.identifier,
                "configuration": binding.model_dump(),
                "diagnostics": ["供应商生成素材已解码校验，未进行视觉模型审美审查。"],
            },
        )
        saved = await self.save_image(current, session_id, claim.identifier, artifact)
        identifier = saved.get("fileId", saved.get("id"))
        if not isinstance(identifier, str) or not identifier:
            raise DomainError(500, "图片存储未返回文件标识")
        return {
            **saved,
            "fileId": identifier,
            "operationId": claim.identifier,
            "mediaType": "image/png",
            "usage": usage,
            "configuration": binding.model_dump(),
        }
