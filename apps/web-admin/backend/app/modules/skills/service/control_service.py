"""技能阶段的会话级公开用例，不允许浏览器伪造工具 ACK。"""

import json

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.entity.bo.resources import Binding
from app.modules.skills.entity.bo.runs import SkillRun
from app.modules.skills.service.runs import SkillRunService, stages


def record(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def stage_views(
    run: SkillRun, outputs: dict[str, object], revision: int
) -> list[dict[str, object]]:
    """历史与当前阶段使用同一DTO；检查通过只能来自服务端持久记录。"""
    resource = record(run.program.get("_resource"))
    calls = record(outputs.get("calls"))
    checks = record(outputs.get("checks"))
    result = []
    for index, stage in enumerate(stages(run.program)):
        raw_calls = calls.get(str(stage["id"]), [])
        records = [record(item) for item in raw_calls] if isinstance(raw_calls, list) else []
        result.append(
            {
                **stage,
                "name": stage.get("name", stage["id"]),
                "skillId": stage.get("skillId", resource.get("id", "")),
                "skillVersion": resource.get("version"),
                "attempt": revision,
                "state": "completed"
                if index < run.stage_index
                else run.state
                if index == run.stage_index
                else "pending",
                "output": outputs.get(str(stage["id"])),
                "checks": checks.get(str(stage["id"]), []),
                "calls": [
                    {
                        "callId": item.get("callId"),
                        "tool": item.get("tool"),
                        "phase": item.get("operation"),
                        "state": "completed",
                        "output": item.get("result"),
                        "auxiliary": item.get("operation") == "auxiliary",
                    }
                    for item in records
                ],
            }
        )
    return result


def run_view(run: SkillRun) -> dict[str, object]:
    """阶段卡片使用稳定 camelCase 字段，原始输出保留供回顾核验。"""
    definitions = stages(run.program)
    resource = record(run.program.get("_resource"))
    metadata = record(run.outputs.get("_meta"))
    raw_history = run.outputs.get("history", [])
    history = (
        [
            item
            for raw in raw_history
            if isinstance(raw, dict)
            for item in stage_views(
                run, record(raw.get("outputs")), int(str(raw.get("revision", run.revision)))
            )
        ]
        if isinstance(raw_history, list)
        else []
    )
    return {
        "id": run.id,
        "runId": run.id,
        "sessionId": run.session_id,
        "bindingId": run.binding_id,
        "state": run.state,
        "revision": run.revision,
        "version": run.version,
        "stageIndex": run.stage_index,
        "stages": stage_views(run, run.outputs, run.revision),
        "skillId": resource.get("id", ""),
        "skillName": resource.get("name", "技能运行"),
        "skillVersion": resource.get("version"),
        "bindingVersion": resource.get("bindingVersion"),
        "requestId": run.request_id,
        "request": "",
        "selection": {"reason": "显式选择会话冻结技能", "candidates": []},
        "history": history,
        "program": {key: value for key, value in run.program.items() if not key.startswith("_")},
        "createdAt": metadata.get("createdAt"),
        "updatedAt": metadata.get("updatedAt"),
        "currentStage": definitions[run.stage_index]
        if run.stage_index < len(definitions)
        else None,
        "planHash": run.plan_hash,
        "approvedHash": run.approved_hash,
        "outputs": {key: value for key, value in run.outputs.items() if not key.startswith("_")},
    }


class SkillControlService:
    """所有运行必须属于当前绑定；重试同一 DSH 调用不会创建第二份运行。"""

    def __init__(self, skills: SkillRunService) -> None:
        self.skills = skills

    async def active(self, account: Account, binding: Binding) -> SkillRun | None:
        runs = [
            run
            for run in await self.skills.listing(account, binding.session_id)
            if run.binding_id == binding.id
            and run.state not in {"completed", "failed", "cancelled"}
        ]
        if len(runs) > 1:
            raise DomainError(409, "multiple active skill runs require explicit resolution")
        return runs[0] if runs else None

    async def invoke(
        self, account: Account, binding: Binding, call_id: str, arguments: dict[str, object]
    ) -> dict[str, object]:
        """阶段选择显式引用冻结技能，不通过名称硬编码业务流程。"""
        action = arguments.get("action")
        if action == "list":
            return {
                "skills": [
                    {key: item.get(key) for key in ("id", "name", "description", "program")}
                    for item in binding.snapshots
                    if item.get("kind") == "skill"
                ],
                "runs": [
                    run_view(run) for run in await self.skills.listing(account, binding.session_id)
                ],
            }
        if action == "start":
            active = await self.active(account, binding)
            if active and active.request_id != call_id:
                raise DomainError(409, "finish or cancel the active skill first")
            return run_view(
                await self.skills.start(
                    account, binding.id, str(arguments.get("skillId", "")), call_id
                )
            )
        run = await self.skills.read(account, str(arguments.get("runId", "")))
        if run.binding_id != binding.id or run.session_id != binding.session_id:
            raise DomainError(404, "skill run not found")
        if action == "status":
            return run_view(run)
        if action == "submit":
            try:
                output = json.loads(str(arguments.get("outputJson", "{}")))
            except ValueError as error:
                raise DomainError(422, "invalid structured submission") from error
            if not isinstance(output, dict):
                raise DomainError(422, "submission must be an object")
            result = await self.skills.submit(account, run.id, run.version, output)
        elif action == "revise":
            result = await self.skills.revise(account, run.id, run.version)
        elif action == "cancel":
            result = await self.skills.cancel(account, run.id, run.version)
        else:
            raise DomainError(422, "unsupported skill action")
        return run_view(result)
