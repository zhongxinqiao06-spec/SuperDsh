"""通用工具方案查询与修订，沿用同一持久收据和冻结工具预检。"""

import json
from datetime import UTC, datetime

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.skills.entity.do.models import ToolExecutionRow
from app.modules.skills.entity.vo.plan_dto import PlanRevisionInput
from app.modules.skills.service.binding_service import object_value
from app.modules.skills.service.runs import stable_hash
from app.modules.skills.service.tool_execution_service import ToolExecutionService


class PlanService:
    """只编辑未执行方案；HTTP 从不生成批准签名或直接触发执行。"""

    def __init__(self, tools: ToolExecutionService) -> None:
        self.tools = tools

    @staticmethod
    def view(row: ToolExecutionRow) -> dict[str, object]:
        saved = object_value((row.result or {}).get("_planRecord"))
        plan = object_value(saved.get("document", (row.result or {}).get("plan")))
        states = {
            "waiting-user": "prepared",
            "preparing": "running",
            "outcome_unknown": "interrupted",
            "completed": "completed",
            "cancelled": "cancelled",
        }
        return {
            "id": row.id,
            "sessionId": row.session_id,
            "tool": row.tool_id,
            "version": saved.get("version", 1),
            "sha256": row.plan_hash,
            "title": plan.get("title", "工具方案"),
            "document": plan,
            "sources": saved.get("sources", []),
            "summary": plan.get("summary", "请核对结构化方案后确认"),
            "warnings": saved.get("warnings", []),
            "state": states.get(row.state, row.state),
            "stage": "complete" if row.state == "completed" else "planning",
            "skillRunId": row.skill_run_id,
            "skillRevision": saved.get("skillRevision"),
            "bindingVersion": saved.get("bindingVersion"),
            "createdAt": row.created_at.isoformat(),
            "updatedAt": row.updated_at.isoformat(),
            "result": {
                key: value for key, value in (row.result or {}).items() if not key.startswith("_")
            }
            if row.state == "completed"
            else None,
        }

    async def read(self, account: Account, session_id: str, identifier: str) -> ToolExecutionRow:
        account.require("files.read")
        receipt = await self.tools.receipt(account, identifier)
        if receipt["sessionId"] != session_id:
            raise DomainError(404, "plan not found")
        async with self.tools.repository.transaction() as dao:
            row = await dao.get(identifier)
        if not row or not row.plan_hash:
            raise DomainError(404, "plan not found")
        return row

    async def listing(self, account: Account, session_id: str) -> dict[str, object]:
        account.require("files.read")
        async with self.tools.repository.transaction() as dao:
            rows = await dao.list(account.user_id, session_id)
        items = []
        for row in rows:
            if row.plan_hash:
                await self.tools.resources.authorize_binding(account, row.binding_id)
                items.append(self.view(row))
        return {"items": items}

    async def revise(
        self, account: Account, session_id: str, identifier: str, body: PlanRevisionInput
    ) -> dict[str, object]:
        account.require("files.write")
        row = await self.read(account, session_id, identifier)
        binding = await self.tools.resources.authorize_binding(account, row.binding_id)
        tool = next(
            (
                value
                for value in binding.snapshots
                if value.get("kind") == "tool" and value.get("id") == row.tool_id
            ),
            None,
        )
        if not tool:
            raise DomainError(404, "plan tool is unavailable")
        run = await self.tools.skills.read(account, row.skill_run_id) if row.skill_run_id else None
        if run and (
            run.version != row.skill_version or run.state not in {"waiting-user", "running"}
        ):
            raise DomainError(409, "skill changed while awaiting plan revision")
        descriptor = object_value(tool.get("descriptor"))
        schema = object_value(tool.get("inputSchema", descriptor.get("inputSchema")))
        properties = object_value(schema.get("properties"))
        arguments = dict(row.arguments)
        if "planJson" in properties:
            arguments["planJson"] = json.dumps(body.document, ensure_ascii=False)
        elif "plan" in properties:
            arguments["plan"] = body.document
        else:
            arguments = object_value(body.document.get("arguments", body.document))
        previous = dict(row.result or {})
        async with self.tools.repository.transaction() as dao:
            await dao.lock(identifier)
            current = await dao.get(identifier)
            if (
                not current
                or current.state != "waiting-user"
                or object_value((current.result or {}).get("_planRecord")).get("version", 1)
                != body.version
            ):
                raise DomainError(409, "plan revision conflict", "revision_conflict")
            current.state = "preparing"
            await dao.save(current)
        try:
            row.arguments = arguments
            if descriptor.get("supportsPreparation") is True:
                output = await self.tools._call(account, binding, tool, row, run, "prepare")
                prepared = object_value(output.get("structuredContent", output))
                plan = object_value(prepared.get("plan"))
                digest = prepared.get("planHash")
                if (
                    not plan
                    or not isinstance(digest, str)
                    or len(digest) != 64
                    or output.get("_pendingArtifacts")
                ):
                    raise DomainError(409, "tool did not return a valid preparation plan")
            else:
                self.tools.resources.validator.validate(arguments, schema)
                plan, digest, prepared = body.document, stable_hash(body.document), {}
            if run and run.state == "waiting-user":
                run = await self.tools.skills.replace_plan(account, run.id, run.version, plan)
            async with self.tools.repository.transaction() as dao:
                await dao.lock(identifier)
                current = await dao.get(identifier)
                if not current or current.state != "preparing":
                    raise DomainError(409, "plan state changed")
                current.arguments, current.input_hash = arguments, stable_hash(arguments)
                current.plan_hash, current.state = digest, "waiting-user"
                current.skill_version = run.version if run else None
                current.result = {
                    "plan": plan,
                    "_planRecord": {
                        **object_value(previous.get("_planRecord")),
                        "version": body.version + 1,
                        "document": plan,
                        "sources": prepared.get(
                            "sources", object_value(previous.get("_planRecord")).get("sources", [])
                        ),
                    },
                }
                current.updated_at = datetime.now(UTC)
                await dao.save(current)
            return {
                "plan": self.view(current),
                "note": "方案已修改，请让助手重新展示并确认；旧确认已失效。",
            }
        except BaseException:
            async with self.tools.repository.transaction() as dao:
                await dao.lock(identifier)
                current = await dao.get(identifier)
                if current and current.state == "preparing":
                    current.state = "waiting-user"
                    await dao.save(current)
            raise
