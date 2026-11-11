"""将收费能力接到通用准备/确认契约；冻结配置只能来自服务端绑定上下文。"""

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.skills.service.runs import stable_hash
from toolkits.office.contracts import record, text
from toolkits.office.multimodal import MultimodalService
from toolkits.office.sources import SourceResolver, json_value


class MultimodalTool:
    """生图/识图是可替换工具实现，不改变会话聊天模型和DSH执行循环。"""

    def __init__(self, service: MultimodalService, sources: SourceResolver) -> None:
        self.service, self.sources = service, sources

    async def execute(
        self,
        account: Account,
        implementation: str,
        arguments: dict[str, object],
        settings: dict[str, object],
        context: dict[str, object],
    ) -> dict[str, object]:
        """确认摘要覆盖能力配置、方案和所有图片摘要；重试不重放收费POST。"""
        bindings = record(context.get("capabilityBindings", {}), "模型能力绑定")
        frozen = bindings.get("modelConfigurationId")
        if not isinstance(frozen, dict):
            raise DomainError(409, "会话缺少冻结的模型能力，请配置后新建会话")
        binding = CapabilityBinding.model_validate(frozen)
        expected = "image.generate" if implementation == "image_generate" else "vision.analyze"
        if binding.capability != expected:
            raise DomainError(403, "工具与冻结模型能力不匹配")
        session_id = text(context.get("sessionId"), "会话", 200)
        phase = context.get("phase")
        if phase == "inspect":
            return {"structuredContent": await self.service.inspect(account, session_id, binding)}
        if phase not in {"prepare", "execute"}:
            raise DomainError(403, "收费能力缺少可信阶段")
        sources = await self.sources.resolve(
            account, text(context.get("bindingId"), "绑定", 200), session_id, arguments
        )
        if any(source.role not in {"input", "image"} for source in sources):
            raise DomainError(422, "多模态工具输入仅支持授权图片")
        images = [source.file for source in sources]
        plan = record(json_value(arguments.get("planJson", arguments.get("plan")), "方案"), "方案")
        prepared = await self.service.prepare(account, session_id, binding, plan, images)
        document = record(prepared["document"], "规范方案")
        digest = stable_hash(
            {
                "plan": document,
                "sources": [source.reference() for source in sources],
                "settings": settings,
            }
        )
        if phase == "prepare":
            return {
                "structuredContent": {
                    "planHash": digest,
                    "plan": document,
                    "sources": [source.reference() for source in sources],
                    **record(prepared.get("preflight", {}), "预检"),
                }
            }
        if context.get("authorizedPlanHash") != digest:
            raise DomainError(409, "多模态方案已变化，请重新确认")
        result = await self.service.execute(
            account, session_id, binding, text(context.get("callId"), "调用", 200), document, images
        )
        pending = result.pop("pendingArtifact", None)
        if pending:
            # 内部操作ID不能当成果ID返回；真实成果ID由通用完成收据登记后生成。
            result.pop("id", None)
            result.pop("fileId", None)
            return {"structuredContent": result, "_pendingArtifacts": [pending]}
        return {"structuredContent": result}
