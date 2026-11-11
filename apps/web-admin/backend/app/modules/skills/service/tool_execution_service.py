"""冻结工具的确认和真实收据，不引入 Agent 队列或场景名称判断。"""

import asyncio
import hashlib
import hmac
from datetime import UTC, datetime

from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.extensions.service.extension_service import ExtensionService
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.entity.bo.resources import Binding
from app.modules.resources.service.resources import ResourceService
from app.modules.skills.dao.execution_dao import ExecutionRepository
from app.modules.skills.entity.bo.runs import SkillRun
from app.modules.skills.entity.do.models import ToolExecutionRow
from app.modules.skills.service.binding_service import object_value
from app.modules.skills.service.control_service import SkillControlService
from app.modules.skills.service.evidence import EvidenceService
from app.modules.skills.service.runs import SkillRunService, stable_hash, stages


class ToolExecutionService:
    """副作用前写未知收据；确认精确引用原始参数，重复回调不能重新执行。"""

    def __init__(
        self,
        database: Database,
        resources: ResourceService,
        extensions: ExtensionService,
        skills: SkillRunService,
        evidence: EvidenceService,
        secret: str,
    ) -> None:
        self.repository = ExecutionRepository(database)
        self.resources, self.extensions, self.skills, self.evidence = (
            resources,
            extensions,
            skills,
            evidence,
        )
        self.controls = SkillControlService(skills)
        self.secret = secret.encode()
        evidence.tool_receipt = self.receipt

    async def receipt(self, account: Account, identifier: str) -> dict[str, object]:
        """成果读取复验资源当前状态，停用和取消授权立即生效。"""
        async with self.repository.transaction() as dao:
            row = await dao.get(identifier)
        if not row or row.owner_id != account.user_id:
            raise DomainError(404, "tool receipt not found")
        await self.resources.authorize_binding(account, row.binding_id)
        return {
            "id": row.id,
            "sessionId": row.session_id,
            "bindingId": row.binding_id,
            "toolId": row.tool_id,
            "callId": row.call_id,
            "state": row.state,
            "result": row.result,
            "skillRunId": row.skill_run_id,
        }

    def _confirmation(self, row: ToolExecutionRow) -> dict[str, object]:
        revision = object_value((row.result or {}).get("_planRecord")).get("version", 1)
        digest = hmac.new(
            self.secret,
            (
                row.id + ":" + str(row.plan_hash) + ":" + row.input_hash + ":" + str(revision)
            ).encode(),
            hashlib.sha256,
        ).hexdigest()
        return {"receiptId": row.id, "planHash": row.plan_hash, "proof": digest}

    async def invoke(
        self,
        account: Account,
        binding: Binding,
        tool: dict[str, object],
        call_id: str,
        arguments: dict[str, object],
        trusted: dict[str, object],
    ) -> dict[str, object]:
        """trusted 只来自受管 DSH 插件，模型 arguments 不参与授权上下文生成。"""
        identifier = "call_" + stable_hash([account.user_id, binding.session_id, call_id])
        phase = trusted.get("phase")
        if phase in {"confirm-execute", "reject-confirmation"}:
            return await self._confirmed(account, binding, tool, identifier, trusted)
        signature = stable_hash(arguments)
        async with self.repository.transaction() as dao:
            existing = await dao.get(identifier)
        if existing:
            if existing.input_hash != signature or existing.tool_id != tool["id"]:
                raise DomainError(409, "tool call idempotency conflict")
            if existing.state == "completed":
                return await self.publish(account, identifier)
            return self._replay(existing)
        descriptor = object_value(tool.get("descriptor"))
        read_actions = descriptor.get("readActions", [])
        read_only = (
            descriptor.get("mode") == "read"
            or isinstance(read_actions, list)
            and arguments.get("action") in read_actions
        )
        run = await self.controls.active(account, binding)
        if run:
            stage = stages(run.program)[run.stage_index]
            if run.state != "running":
                raise DomainError(409, "skill is waiting or interrupted")
            allowed = stage.get("toolIds", [])
            if read_only and stage["operation"] == "submit":
                auxiliary = stage.get("inspectToolIds", [])
                allowed = [
                    *(allowed if isinstance(allowed, list) else []),
                    *(auxiliary if isinstance(auxiliary, list) else []),
                ]
            if not isinstance(allowed, list) or tool["id"] not in allowed:
                raise DomainError(403, "tool is not allowed in the current skill stage")
            if (not read_only and stage["operation"] not in {"prepare", "submit"}) or (
                read_only and stage["operation"] not in {"inspect", "submit"}
            ):
                raise DomainError(403, "operation does not match the current skill stage")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            previous = await dao.get(identifier)
            if previous:
                if previous.input_hash != signature or previous.tool_id != tool["id"]:
                    raise DomainError(409, "tool call idempotency conflict")
                return self._replay(previous)
            now = datetime.now(UTC)
            row = ToolExecutionRow(
                id=identifier,
                owner_id=account.user_id,
                session_id=binding.session_id,
                binding_id=binding.id,
                tool_id=str(tool["id"]),
                call_id=call_id,
                phase="inspect" if read_only else "prepare",
                input_hash=signature,
                state="outcome_unknown",
                arguments=arguments,
                result=None,
                plan_hash=None,
                skill_run_id=run.id if run else None,
                skill_version=run.version if run else None,
                created_at=now,
                updated_at=now,
            )
            await dao.save(row)
        if read_only:
            return await self._execute(account, binding, tool, row, run, "inspect")
        try:
            if descriptor.get("supportsPreparation") is True:
                result = await self._call(account, binding, tool, row, run, "prepare")
                if result.get("_pendingArtifacts"):
                    raise DomainError(409, "prepare must not create final artifacts")
                payload = object_value(result.get("structuredContent", result))
                plan = object_value(payload.get("plan"))
                plan_hash = payload.get("planHash")
                if not plan or not isinstance(plan_hash, str) or len(plan_hash) != 64:
                    raise DomainError(409, "tool did not return a valid preparation plan")
            else:
                plan = {
                    "title": str(tool.get("name", "工具调用")),
                    "summary": "即将按以下参数执行已绑定工具，请核对目标与输入。",
                    "arguments": arguments,
                }
                plan_hash = stable_hash(plan)
            if run and stages(run.program)[run.stage_index]["operation"] == "prepare":
                run = await self.skills.prepare(account, run.id, run.version, plan)
            async with self.repository.transaction() as dao:
                await dao.lock(identifier)
                current = await dao.get(identifier)
                assert current is not None
                current.state, current.plan_hash = "waiting-user", plan_hash
                current.skill_version = run.version if run else None
                current.result = {
                    "plan": plan,
                    "_planRecord": {
                        "version": 1,
                        "document": plan,
                        "sources": payload.get("sources", [])
                        if descriptor.get("supportsPreparation") is True
                        else [],
                        "bindingVersion": binding.version,
                        "skillRevision": run.revision if run else None,
                    },
                }
                current.updated_at = datetime.now(UTC)
                await dao.save(current)
                return self._replay(current)
        except BaseException:
            # 预检失败可能已在外部完成，保留未知收据，不能自动重试同一次操作。
            raise

    def _replay(self, row: ToolExecutionRow) -> dict[str, object]:
        if row.state == "completed":
            return {
                key: value for key, value in (row.result or {}).items() if not key.startswith("_")
            }
        if row.state == "waiting-user":
            return {
                **{
                    key: value
                    for key, value in (row.result or {}).items()
                    if not key.startswith("_")
                },
                "confirmation": self._confirmation(row),
            }
        if row.state == "cancelled":
            return {"status": "cancelled", "receiptId": row.id}
        raise DomainError(
            409, "tool outcome is unknown; do not automatically repeat", "operation_outcome_unknown"
        )

    async def _confirmed(
        self,
        account: Account,
        binding: Binding,
        tool: dict[str, object],
        identifier: str,
        trusted: dict[str, object],
    ) -> dict[str, object]:
        async with self.repository.transaction() as dao:
            existing = await dao.get(identifier)
        if (
            existing
            and existing.owner_id == account.user_id
            and existing.binding_id == binding.id
            and existing.tool_id == tool["id"]
            and existing.state == "completed"
        ):
            supplied = object_value(trusted.get("confirmation"))
            if not hmac.compare_digest(
                stable_hash(supplied), stable_hash(self._confirmation(existing))
            ):
                raise DomainError(403, "invalid tool confirmation")
            return await self.publish(account, identifier)
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.get(identifier)
            if (
                not row
                or row.owner_id != account.user_id
                or row.binding_id != binding.id
                or row.tool_id != tool["id"]
            ):
                raise DomainError(404, "prepared tool call not found")
            supplied = object_value(trusted.get("confirmation"))
            if not hmac.compare_digest(stable_hash(supplied), stable_hash(self._confirmation(row))):
                raise DomainError(403, "invalid tool confirmation")
            if row.state != "waiting-user":
                return self._replay(row)
            row.state = (
                "cancelled" if trusted["phase"] == "reject-confirmation" else "outcome_unknown"
            )
            row.phase = "execute"
            row.updated_at = datetime.now(UTC)
            await dao.save(row)
        run = await self.skills.read(account, row.skill_run_id) if row.skill_run_id else None
        if run and run.version != row.skill_version:
            raise DomainError(409, "skill changed while awaiting confirmation")
        if row.state == "cancelled":
            if run and run.state == "waiting-user":
                if trusted.get("cancelledByUser") is True:
                    await self.skills.cancel(account, run.id, run.version)
                else:
                    await self.skills.revise(account, run.id, run.version)
            return {"status": "cancelled", "feedback": str(trusted.get("feedback", ""))[:4000]}
        if run and run.state == "waiting-user":
            run = await self.skills.confirm(account, run.id, run.version, run.plan_hash or "")
        return await self._execute(account, binding, tool, row, run, "execute")

    async def _call(
        self,
        account: Account,
        binding: Binding,
        tool: dict[str, object],
        row: ToolExecutionRow,
        run: SkillRun | None,
        phase: str,
    ) -> dict[str, object]:
        context: dict[str, object] = {
            "sessionId": binding.session_id,
            "bindingId": binding.id,
            "toolResourceId": tool["id"],
            "callId": row.call_id,
            "receiptId": row.id,
            "phase": phase,
            "capabilityBindings": tool.get("capabilityBindings", {}),
        }
        if row.plan_hash and phase == "execute":
            context["authorizedPlanHash"] = row.plan_hash
        if run:
            stage = stages(run.program)[run.stage_index]
            context.update(
                {
                    "skillRunId": run.id,
                    "skillRevision": run.revision,
                    "currentStage": {
                        "kind": stage["operation"],
                        "toolIds": stage.get("toolIds", []),
                    },
                }
            )
        config = await self.resources.execution_configuration(account, binding.id, str(tool["id"]))
        descriptor = object_value(tool.get("descriptor"))
        async with asyncio.timeout(float(str(descriptor.get("timeoutSeconds", 120)))):
            return await self.extensions.execute(
                account, object_value(tool.get("implementation")), row.arguments, config, context
            )

    async def _execute(
        self,
        account: Account,
        binding: Binding,
        tool: dict[str, object],
        row: ToolExecutionRow,
        run: SkillRun | None,
        phase: str,
    ) -> dict[str, object]:
        if run:
            stage = stages(run.program)[run.stage_index]
            if stage["operation"] == "submit":
                primary = stage.get("toolIds", [])
                operation = (
                    "invoke" if isinstance(primary, list) and tool["id"] in primary else "inspect"
                )
                run = await self.skills.begin_auxiliary(
                    account, run.id, run.version, row.id, str(tool["id"]), operation
                )
            elif phase == "inspect":
                run = await self.skills.begin_auxiliary(
                    account, run.id, run.version, row.id, str(tool["id"]), "inspect"
                )
            else:
                run = await self.skills.begin_call(
                    account, run.id, run.version, row.id, str(tool["id"])
                )
        result = await self._call(account, binding, tool, row, run, phase)
        pending = result.pop("_pendingArtifacts", [])
        if not isinstance(pending, list) or any(not isinstance(item, dict) for item in pending):
            raise DomainError(502, "invalid tool artifact publication")
        if run:
            pending = [
                {
                    **item,
                    "metadata": {
                        **object_value(item.get("metadata")),
                        "skillRunId": run.id,
                        "skillRevision": run.revision,
                    },
                }
                for item in pending
            ]
        if result.get("isError") is True:
            raise DomainError(502, "tool returned an execution error")
        # 完成真实执行后先持久收据，再发布产物；若发布中断可从同一收据补齐。
        if run:
            run = await self.skills.acknowledge(account, run.id, run.version, row.id, result)
        async with self.repository.transaction() as dao:
            await dao.lock(row.id)
            current = await dao.get(row.id)
            assert current is not None
            current.state, current.result = (
                "completed",
                {
                    **result,
                    "_pendingArtifacts": pending,
                    "_planRecord": (current.result or {}).get("_planRecord"),
                },
            )
            current.updated_at = datetime.now(UTC)
            await dao.save(current)
        return await self.publish(account, row.id)

    async def publish(self, account: Account, identifier: str) -> dict[str, object]:
        """登记中断仅重放确定性的元数据发布，绝不再次调用产生副作用的工具。"""
        receipt = await self.receipt(account, identifier)
        result = object_value(receipt.get("result"))
        pending = result.pop("_pendingArtifacts", [])
        if not isinstance(pending, list):
            raise DomainError(409, "invalid persisted artifact receipt")
        artifacts = []
        for item in pending:
            artifact = await self.evidence.register_tool_artifact(
                account, identifier, object_value(item)
            )
            artifacts.append(self.evidence.view(artifact))
        if artifacts:
            result["artifacts"] = artifacts
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.get(identifier)
            assert row is not None
            row.result = result
            await dao.save(row)
        return {key: value for key, value in result.items() if not key.startswith("_")}
