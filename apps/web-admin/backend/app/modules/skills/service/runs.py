"""可配置阶段服务：记录 DSH 的执行证据，不创建第二调度队列。"""

import hashlib
import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.service.ports import SchemaValidator
from app.modules.resources.service.resources import ResourceService
from app.modules.skills.entity.bo.runs import SkillRun
from app.modules.skills.service.ports import RunRepository, RunTransaction, TransitionAdapter


def stable_hash(value: object) -> str:
    """方案哈希使用稳定 JSON；修订后旧确认不再授权新输入。"""
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def stages(program: dict[str, object]) -> list[dict[str, object]]:
    """验证阶段组合，prepare/execute 必须相邻且引用相同工具。"""
    value = program.get("stages")
    if (
        not isinstance(value, list)
        or not value
        or len(value) > 30
        or any(not isinstance(stage, dict) for stage in value)
    ):
        raise DomainError(422, "invalid skill stages")
    identifiers: set[str] = set()
    for index, stage in enumerate(value):
        if (
            not isinstance(stage.get("id"), str)
            or stage["id"] in identifiers
            or stage.get("operation") not in {"inspect", "submit", "prepare", "execute", "review"}
        ):
            raise DomainError(422, "invalid skill stage")
        identifiers.add(stage["id"])
        if stage["operation"] == "prepare" and (
            index + 1 >= len(value)
            or value[index + 1].get("operation") != "execute"
            or value[index + 1].get("toolIds") != stage.get("toolIds")
        ):
            raise DomainError(422, "prepare must precede execute with the same tools")
        if stage["operation"] == "execute" and (
            index == 0 or value[index - 1].get("operation") != "prepare"
        ):
            raise DomainError(422, "execute requires an adjacent prepare stage")
    return value


class SkillRunService:
    """阶段推进、确认和收据由数据库仲裁；可选图实现只观察提交结果。"""

    def __init__(
        self,
        repository: RunRepository,
        resources: ResourceService,
        validator: SchemaValidator,
        adapter: TransitionAdapter | None = None,
    ) -> None:
        self.repository, self.resources, self.validator, self.adapter = (
            repository,
            resources,
            validator,
            adapter,
        )
        self.evidence_validator: (
            Callable[
                [Account, SkillRun, dict[str, object], dict[str, object]],
                Awaitable[list[dict[str, object]]],
            ]
            | None
        ) = None

    async def start(
        self, account: Account, binding_id: str, skill_id: str, request_id: str
    ) -> SkillRun:
        """仅绑定中的冻结技能可启动；相同稳定请求返回同一记录。"""
        binding = await self.resources.authorize_binding(account, binding_id)
        skill = next(
            (
                item
                for item in binding.snapshots
                if item.get("id") == skill_id and item.get("kind") == "skill"
            ),
            None,
        )
        program = skill.get("program") if skill else None
        if not isinstance(program, dict):
            raise DomainError(422, "bound skill has no published stage program")
        assert skill is not None
        program = {
            **program,
            "_resource": {
                "id": skill["id"],
                "name": skill.get("name"),
                "version": skill["version"],
                "bindingVersion": binding.version,
            },
        }
        definitions = stages(program)
        permitted_tools = {
            str(item["id"]) for item in binding.snapshots if item.get("kind") == "tool"
        }
        for stage in definitions:
            for field in ("toolIds", "inspectToolIds"):
                requested = stage.get(field, [])
                if not isinstance(requested, list) or not set(requested).issubset(permitted_tools):
                    raise DomainError(403, "stage references an unbound tool")
        async with self.repository.transaction() as tx:
            await tx.lock(f"{account.user_id}:{binding.session_id}:{request_id}")
            previous = await tx.find(account.user_id, binding.session_id, request_id)
            if previous:
                if previous.binding_id != binding_id or previous.program != program:
                    raise DomainError(409, "request id was used for different input")
                return previous
            run = SkillRun(
                str(uuid4()), account.user_id, binding.session_id, binding_id, request_id, program
            )
            stamp = datetime.now(UTC).isoformat()
            run.outputs = {"_meta": {"createdAt": stamp, "updatedAt": stamp}}
            await tx.save(run, "started")
            return run

    async def read(self, account: Account, run_id: str) -> SkillRun:
        """读取记录也复验账号和当前资源停用状态。"""
        async with self.repository.transaction() as tx:
            run = await tx.get(run_id)
        if run is None or run.owner_id != account.user_id:
            raise DomainError(404, "skill run not found")
        await self.resources.authorize_binding(account, run.binding_id)
        return run

    async def listing(self, account: Account, session_id: str) -> list[SkillRun]:
        """上层会话用例先核验归属；仅列本账号记录，不触发任务。"""
        account.require("files.read")
        async with self.repository.transaction() as tx:
            return await tx.runs(account.user_id, session_id)

    async def _locked(
        self, tx: RunTransaction, account: Account, run_id: str, version: int
    ) -> SkillRun:
        await tx.lock(run_id)
        run = await tx.get(run_id)
        if run is None or run.owner_id != account.user_id:
            raise DomainError(404, "skill run not found")
        if run.version != version:
            raise DomainError(409, "stale skill state", "revision_conflict")
        if run.state in {"completed", "failed", "cancelled"}:
            raise DomainError(409, "skill run has ended")
        return run

    async def submit(
        self, account: Account, run_id: str, version: int, output: dict[str, object]
    ) -> SkillRun:
        """结构化提交不会替代工具证据；需要专用检查的阶段由校验器扩展。"""
        current = await self.read(account, run_id)
        if current.version != version or current.stage_index >= len(stages(current.program)):
            raise DomainError(409, "stale or completed skill state", "revision_conflict")
        verified: list[dict[str, object]] = []
        if self.evidence_validator:
            verified = await self.evidence_validator(
                account, current, stages(current.program)[current.stage_index], output
            )
        async with self.repository.transaction() as tx:
            run = await self._locked(tx, account, run_id, version)
            stage = stages(run.program)[run.stage_index]
            if run.state != "running" or stage["operation"] not in {"inspect", "submit", "review"}:
                raise DomainError(409, "stage cannot accept a structured submission")
            checks = stage.get("checks", [])
            if not isinstance(checks, list) or any(
                check
                not in {"schema", "tool_receipt", "sources", "plan", "artifact", "rendered-quality"}
                for check in checks
            ):
                raise DomainError(409, "stage requires registered server evidence validators")
            if (
                any(
                    check in {"sources", "plan", "artifact", "rendered-quality"} for check in checks
                )
                and not self.evidence_validator
            ):
                raise DomainError(503, "stage evidence validators are unavailable")
            calls = run.outputs.get("calls", {})
            stage_calls = calls.get(str(stage["id"]), []) if isinstance(calls, dict) else []
            if (stage["operation"] == "inspect" or "tool_receipt" in checks) and not stage_calls:
                raise DomainError(409, "stage requires a real tool receipt")
            schema = stage.get("outputSchema", {"type": "object"})
            if not isinstance(schema, dict):
                raise DomainError(422, "invalid output schema")
            self.validator.validate(output, schema)
            recorded = run.outputs.get("checks", {})
            recorded = dict(recorded) if isinstance(recorded, dict) else {}
            recorded[str(stage["id"])] = [
                {
                    "validator": "schema",
                    "version": run.version,
                    "passed": True,
                    "message": "结构化输出通过冻结Schema校验",
                    "evidenceHash": stable_hash(output),
                },
                *verified,
            ]
            run.outputs = {**run.outputs, str(stage["id"]): output, "checks": recorded}
            self._advance(run)
            await self._save(tx, run, "submitted")
            return run

    @staticmethod
    def _advance(run: SkillRun) -> None:
        run.stage_index += 1
        run.state = "completed" if run.stage_index >= len(stages(run.program)) else "running"

    async def prepare(
        self, account: Account, run_id: str, version: int, plan: dict[str, object]
    ) -> SkillRun:
        """只有真实工具预检调用方使用，等待用户阶段不持有生成计时器。"""
        await self.read(account, run_id)
        async with self.repository.transaction() as tx:
            run = await self._locked(tx, account, run_id, version)
            if (
                run.state != "running"
                or stages(run.program)[run.stage_index]["operation"] != "prepare"
            ):
                raise DomainError(409, "stage does not prepare a tool")
            run.plan_hash = stable_hash({"plan": plan, "revision": run.revision})
            run.outputs = {**run.outputs, "plan": plan}
            run.approved_hash = None
            run.state = "waiting-user"
            await tx.approval(run, "pending")
            await self._save(tx, run, "plan-prepared")
            return run

    async def confirm(
        self, account: Account, run_id: str, version: int, plan_hash: str
    ) -> SkillRun:
        """只确认当前修订的精确方案哈希，重复或旧确认不会触发执行。"""
        await self.read(account, run_id)
        async with self.repository.transaction() as tx:
            run = await self._locked(tx, account, run_id, version)
            if run.state != "waiting-user" or run.plan_hash != plan_hash:
                raise DomainError(409, "plan confirmation is stale")
            run.approved_hash = plan_hash
            await tx.approval(run, "approved")
            self._advance(run)
            await self._save(tx, run, "confirmed")
            return run

    async def replace_plan(
        self, account: Account, run_id: str, version: int, plan: dict[str, object]
    ) -> SkillRun:
        """方案编辑只更新等待确认的精确阶段，立即失效旧批准，不推进执行。"""
        await self.read(account, run_id)
        async with self.repository.transaction() as tx:
            run = await self._locked(tx, account, run_id, version)
            if run.state != "waiting-user" or run.pending_call:
                raise DomainError(409, "skill is no longer waiting for plan review")
            run.plan_hash = stable_hash({"plan": plan, "revision": run.revision})
            run.approved_hash = None
            run.outputs = {**run.outputs, "plan": plan}
            await tx.approval(run, "pending")
            await self._save(tx, run, "plan-revised")
            return run

    async def begin_call(
        self, account: Account, run_id: str, version: int, call_id: str, tool_id: str
    ) -> SkillRun:
        """DSH 提交副作用前落收据；同 ID 未知结果不自动再次执行。"""
        await self.read(account, run_id)
        async with self.repository.transaction() as tx:
            run = await self._locked(tx, account, run_id, version)
            stage = stages(run.program)[run.stage_index]
            tool_ids = stage.get("toolIds", [])
            if (
                run.state != "running"
                or run.pending_call is not None
                or stage["operation"] != "execute"
                or not isinstance(tool_ids, list)
                or tool_id not in tool_ids
                or not run.approved_hash
                or run.approved_hash != run.plan_hash
            ):
                raise DomainError(403, "tool execution has no current confirmation")
            if await tx.receipt(call_id):
                raise DomainError(
                    409, "tool operation outcome is already recorded", "operation_outcome_unknown"
                )
            run.pending_call, run.state = call_id, "executing"
            run.outputs = {
                **run.outputs,
                "pendingOperation": {"mode": "execute", "toolId": tool_id},
            }
            await tx.save_receipt(run, call_id, "outcome_unknown", None)
            await self._save(tx, run, "tool-submitted")
            return run

    async def acknowledge(
        self, account: Account, run_id: str, version: int, call_id: str, result: dict[str, object]
    ) -> SkillRun:
        """仅受管工具/DSH 回调使用；不提供接受浏览器伪造 ACK 的 HTTP 入口。"""
        await self.read(account, run_id)
        async with self.repository.transaction() as tx:
            run = await self._locked(tx, account, run_id, version)
            receipt = await tx.receipt(call_id)
            if (
                run.state not in {"executing", "interrupted"}
                or run.pending_call != call_id
                or not receipt
                or receipt["runId"] != run.id
                or receipt["revision"] != run.revision
            ):
                raise DomainError(409, "late or unrelated tool result")
            pending = run.outputs.get("pendingOperation", {})
            mode = pending.get("mode", "execute") if isinstance(pending, dict) else "execute"
            stage_id = str(stages(run.program)[run.stage_index]["id"])
            raw_calls = run.outputs.get("calls", {})
            recorded_calls = dict(raw_calls) if isinstance(raw_calls, dict) else {}
            raw_stage_calls = recorded_calls.get(stage_id, [])
            stage_calls = raw_stage_calls if isinstance(raw_stage_calls, list) else []
            recorded_calls[stage_id] = [
                *stage_calls,
                {
                    "callId": call_id,
                    "operation": mode,
                    "tool": pending.get("toolId") if isinstance(pending, dict) else None,
                    "result": result,
                },
            ]
            run.outputs = {**run.outputs, "calls": recorded_calls, stage_id: result}
            run.outputs.pop("pendingOperation", None)
            await tx.save_receipt(run, call_id, "completed", result)
            run.pending_call = None
            if mode == "auxiliary":
                run.state = "running"
            else:
                self._advance(run)
            await self._save(tx, run, "tool-acknowledged")
            return run

    async def begin_auxiliary(
        self,
        account: Account,
        run_id: str,
        version: int,
        call_id: str,
        tool_id: str,
        operation: str,
    ) -> SkillRun:
        """submit 可多次使用已绑定辅助工具；inspect 白名单不授权生成操作。"""
        await self.read(account, run_id)
        async with self.repository.transaction() as tx:
            run = await self._locked(tx, account, run_id, version)
            stage = stages(run.program)[run.stage_index]
            field = (
                "inspectToolIds"
                if operation == "inspect" and stage["operation"] == "submit"
                else "toolIds"
            )
            allowed = stage.get(field, [])
            if (
                run.state != "running"
                or stage["operation"] not in {"inspect", "submit"}
                or operation not in {"inspect", "invoke"}
                or not isinstance(allowed, list)
                or tool_id not in allowed
            ):
                raise DomainError(403, "auxiliary tool is not authorized for this stage")
            if stage["operation"] == "inspect" and operation != "inspect":
                raise DomainError(403, "inspection stage only accepts read-only tools")
            if await tx.receipt(call_id):
                raise DomainError(409, "operation id already exists", "operation_outcome_unknown")
            run.pending_call, run.state = call_id, "executing"
            run.outputs = {
                **run.outputs,
                "pendingOperation": {
                    "mode": "auxiliary" if stage["operation"] == "submit" else "inspect",
                    "toolId": tool_id,
                },
            }
            await tx.save_receipt(run, call_id, "outcome_unknown", None)
            await self._save(tx, run, "tool-submitted")
            return run

    async def revise(self, account: Account, run_id: str, version: int) -> SkillRun:
        """显式修订保留原输出历史、失效旧确认，不能修订仍在执行的工具。"""
        await self.read(account, run_id)
        async with self.repository.transaction() as tx:
            run = await self._locked(tx, account, run_id, version)
            if run.pending_call or run.revision > int(str(run.program.get("maxRevisions", 2))):
                raise DomainError(409, "running tool or revision limit prevents revision")
            history = run.outputs.get("history", [])
            history = history if isinstance(history, list) else []
            run.outputs = {
                "_meta": run.outputs.get("_meta", {}),
                "history": [*history, {"revision": run.revision, "outputs": run.outputs}],
            }
            run.revision += 1
            run.stage_index = 0
            run.plan_hash = run.approved_hash = None
            run.state = "running"
            await self._save(tx, run, "revised")
            return run

    async def cancel(self, account: Account, run_id: str, version: int) -> SkillRun:
        """取消阶段仅记录意图；在途工具先由 DSH 取消并核实结束。"""
        await self.read(account, run_id)
        async with self.repository.transaction() as tx:
            run = await self._locked(tx, account, run_id, version)
            if run.pending_call:
                raise DomainError(409, "interrupt the running DSH tool before cancelling the skill")
            run.state = "cancelled"
            await self._save(tx, run, "cancelled")
            return run

    async def recover(self) -> None:
        """取得平台独占权后标记中断，原收据保持未知且不重放工具。"""
        async with self.repository.transaction() as tx:
            await tx.lock("recovery")
            for run in await tx.active():
                run.state = "interrupted"
                await self._save(tx, run, "platform-restarted")

    async def _save(self, tx: RunTransaction, run: SkillRun, event: str) -> None:
        run.version += 1
        metadata = run.outputs.get("_meta", {})
        run.outputs = {
            **run.outputs,
            "_meta": {
                **(metadata if isinstance(metadata, dict) else {}),
                "updatedAt": datetime.now(UTC).isoformat(),
            },
        }
        if self.adapter is not None:
            await self.adapter.record(run.id, run.version, event, run.state)
        await tx.save(run, event)
