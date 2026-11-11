"""会话资源、固定 DSH 回调与工具收据的装配用例。"""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import cast

from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.extensions.service.extension_service import ExtensionService
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.identity import IdentityService
from app.modules.knowledge.service.knowledge_service import KnowledgeService
from app.modules.resources.entity.bo.resources import Binding
from app.modules.resources.service.resources import ResourceService
from app.modules.runtime.entity.bo.values import Fields, Json
from app.modules.runtime.service.runtime import RuntimeService
from app.modules.skills.entity.do.models import ToolExecutionRow
from app.modules.skills.service.binding_service import (
    AgentBindingService,
    engine_tool,
    object_value,
)
from app.modules.skills.service.evidence import EvidenceService
from app.modules.skills.service.plan_service import PlanService
from app.modules.skills.service.reference_service import ReferenceService
from app.modules.skills.service.runs import SkillRunService, stable_hash
from app.modules.skills.service.stage_evidence_service import StageEvidenceService
from app.modules.skills.service.tool_execution_service import ToolExecutionService


class AgentExecutionService:
    """本服务只响应既有 DSH 工具请求，不生成或调度模型任务。"""

    def __init__(
        self,
        database: Database,
        identity: IdentityService,
        resources: ResourceService,
        extensions: ExtensionService,
        skills: SkillRunService,
        evidence: EvidenceService,
        conversations: ConversationService,
        runtime: Callable[[], RuntimeService],
        secret: str,
        knowledge: KnowledgeService | None = None,
    ) -> None:
        self.identity, self.skills = identity, skills
        self.binding = AgentBindingService(resources, conversations, runtime)
        self.tools = ToolExecutionService(database, resources, extensions, skills, evidence, secret)
        self.plans = PlanService(self.tools)
        self.references = ReferenceService(self.tools, conversations, knowledge)
        skills.evidence_validator = StageEvidenceService(evidence, knowledge).validate

    async def assert_binding_idle(self, account: Account, session_id: str) -> None:
        """未决工具或确认仍绑定原资源，必须先处理完再更换智能体。"""
        async with self.tools.repository.transaction() as dao:
            if await dao.pending(account.user_id, session_id):
                raise DomainError(409, "本会话仍有工具正在执行或等待确认，请先取消或等待完成")

    async def callback(self, owner: str, message: Fields) -> Json:
        """监督器已校验引擎会话，此处仍重新读取账号、绑定和工具状态。"""
        account = await self.identity.get_account(owner)
        session_id, call_id = message.get("sessionId"), message.get("callId")
        if (
            not isinstance(session_id, str)
            or not isinstance(call_id, str)
            or not 1 <= len(call_id) <= 200
        ):
            raise DomainError(422, "invalid runtime tool context")
        binding = await self.binding.frozen(account, session_id)
        arguments = object_value(message.get("arguments"))
        identifier = message.get("toolId")
        if identifier == engine_tool(binding.id, "skill_control"):
            return cast(Json, await self._control(account, binding, call_id, arguments))
        tool = next(
            (
                item
                for item in binding.snapshots
                if item.get("kind") == "tool"
                and engine_tool(binding.id, str(item["id"])) == identifier
            ),
            None,
        )
        if not tool or message.get("revision") != tool["version"]:
            raise DomainError(403, "runtime tool revision is not bound")
        return cast(
            Json,
            await self.tools.invoke(
                account, binding, tool, call_id, arguments, object_value(message.get("context"))
            ),
        )

    async def _control(
        self, account: Account, binding: Binding, call_id: str, arguments: dict[str, object]
    ) -> dict[str, object]:
        identifier = "control_" + stable_hash([account.user_id, binding.session_id, call_id])
        signature = stable_hash(arguments)
        async with self.tools.repository.transaction() as dao:
            await dao.lock(identifier)
            prior = await dao.get(identifier)
            if prior:
                if prior.input_hash != signature:
                    raise DomainError(409, "skill call idempotency conflict")
                return self.tools._replay(prior)
            now = datetime.now(UTC)
            await dao.save(
                ToolExecutionRow(
                    id=identifier,
                    owner_id=account.user_id,
                    session_id=binding.session_id,
                    binding_id=binding.id,
                    tool_id="skill_control",
                    call_id=call_id,
                    phase="control",
                    input_hash=signature,
                    state="outcome_unknown",
                    arguments=arguments,
                    result=None,
                    plan_hash=None,
                    skill_run_id=None,
                    skill_version=None,
                    created_at=now,
                    updated_at=now,
                )
            )
        result = await self.tools.controls.invoke(account, binding, call_id, arguments)
        async with self.tools.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.get(identifier)
            assert row is not None
            row.state, row.result = "completed", result
            row.updated_at = datetime.now(UTC)
            await dao.save(row)
        return result
