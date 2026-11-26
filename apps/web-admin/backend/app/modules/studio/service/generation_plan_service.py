"""作品与个人库共享的冻结计划及确认事务，不持有数据库锁等待外部模型。"""

from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.billing.service.quote_service import lock_plan_quote
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.production_dao import ProductionDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.bo.production import ACTIVE, UNCERTAIN, candidate_state, input_hash
from app.modules.studio.entity.do.models import MediaJob
from app.modules.studio.entity.do.production_do import GenerationPlan
from app.modules.studio.entity.vo.production_vo import ConfirmPlan
from app.modules.studio.entity.vo.studio_vo import identifier
from app.modules.studio.service.plan_pricing import quote_manifest
from app.modules.studio.service.series_access_service import assert_episode_editable
from app.modules.studio.service.studio_service import job_view

if TYPE_CHECKING:
    from app.modules.studio.service.media_jobs import MediaJobs


def plan_view(plan: GenerationPlan) -> dict:
    """展示字段不包含供应商凭据、签名下载地址或后台任务输入正文。"""
    return {
        "id": plan.id,
        "revision": plan.revision,
        "planHash": plan.plan_hash,
        "state": plan.state,
        "items": [
            {k: v for k, v in item.items() if k != "payload"} for item in plan.manifest["items"]
        ],
        "issues": plan.manifest["issues"],
        "result": plan.result,
        "estimatedCost": None,
        "usageQuote": (plan.result or {}).get("usageQuote") or plan.manifest.get("usageQuote"),
    }


class GenerationPlans:
    def __init__(self, media: "MediaJobs") -> None:
        self.media = media

    async def replay(
        self, account: Account, project: str | None, entity: str | None, intent: dict
    ) -> dict | None:
        """先核对已持久化意图；网络重试不受随后工程编辑或默认模型变化影响。"""
        async with self.media.database.sessions() as session:
            previous = await ProductionDao(session).request(account.user_id, intent["requestKey"])
            if not previous:
                return None
            if previous.request_hash != content_hash(
                {"project": project, "entity": entity, "intent": intent}
            ):
                raise DomainError(409, "请求号已用于其它制作计划")
            return plan_view(previous)

    async def store(
        self,
        account: Account,
        project: str | None,
        entity: str | None,
        intent: dict,
        manifest: dict,
    ) -> dict:
        async with self.media.database.sessions.begin() as session:
            dao = ProductionDao(session)
            if project:
                record = await StudioDao(session).project(account.user_id, project, lock=True)
                revision = record.revision
                if record.lifecycle == "archived":
                    raise DomainError(409, "请先恢复作品")
                await assert_episode_editable(session, account, record)
            else:
                revision = (await dao.entity(account.user_id, entity or "", lock=True)).revision
            previous = await dao.request(account.user_id, intent["requestKey"])
            fingerprint = content_hash({"project": project, "entity": entity, "intent": intent})
            if previous:
                if previous.request_hash != fingerprint:
                    raise DomainError(409, "请求号已用于其它制作计划")
                return plan_view(previous)
            if revision != intent["revision"]:
                raise DomainError(409, "内容已更新，请重新预检")
            identity = identifier()
            manifest = await quote_manifest(session, account.user_id, identity, manifest)
            plan = GenerationPlan(
                id=identity,
                owner=account.user_id,
                project=project,
                entity=entity,
                revision=revision,
                request_key=intent["requestKey"],
                request_hash=fingerprint,
                plan_hash=content_hash(manifest),
                intent=intent,
                manifest=manifest,
                state="draft",
            )
            dao.add(plan)
            return plan_view(plan)

    async def read(
        self, account: Account, identity: str, project: str | None, entity: str | None
    ) -> GenerationPlan:
        async with self.media.database.sessions() as session:
            plan = await ProductionDao(session).plan(account.user_id, identity)
            if (plan.project, plan.entity) != (project, entity):
                raise DomainError(404, "制作计划不存在")
            return plan

    async def confirm(
        self, account: Account, identity: str, body: ConfirmPlan, rebuilt: dict
    ) -> dict:
        async with self.media.database.sessions.begin() as session:
            dao = ProductionDao(session)
            plan = await dao.plan(account.user_id, identity)
            # 所有制作先锁所属对象再锁计划，与保存/创建计划的顺序一致。
            if plan.project:
                project = await StudioDao(session).project(account.user_id, plan.project, lock=True)
                revision = project.revision
                jobs = await StudioDao(session).jobs(project)
                if project.lifecycle == "archived":
                    raise DomainError(409, "请先恢复作品")
            else:
                revision = (
                    await dao.entity(account.user_id, plan.entity or "", lock=True)
                ).revision
                jobs = await dao.personal_jobs(account.user_id, plan.entity or "")
            plan = await dao.plan(account.user_id, identity, lock=True)
            if body.planHash != plan.plan_hash or body.revision != plan.revision:
                raise DomainError(409, "确认内容与原计划不一致")
            if plan.state == "confirmed":
                return plan.result or {}
            if plan.project:
                await assert_episode_editable(session, account, project)
            quote = plan.manifest.get("usageQuote")
            if quote:
                rebuilt = {**rebuilt, "usageQuote": quote}
            if revision != plan.revision or content_hash(rebuilt) != plan.plan_hash:
                raise DomainError(409, "作品、模型或任务状态已变化，请重新预检")
            if rebuilt["issues"] or not any(i["selected"] for i in rebuilt["items"]):
                raise DomainError(422, "请先处理阻塞项并选择需要制作的内容")
            if not quote:
                raise DomainError(409, "旧计划缺少报价，请重新预检")
            locked = await lock_plan_quote(session, account.user_id, plan.id, quote["id"])
            rows: list[MediaJob] = []
            for item in rebuilt["items"]:
                if not item["selected"]:
                    continue
                previous = [
                    j for j in jobs if j.subject == item["target"] and j.kind == item["kind"]
                ]
                if any(j.state in ACTIVE for j in previous):
                    raise DomainError(409, "同一内容已有任务执行，请刷新制作计划")
                if any(
                    j.state in UNCERTAIN and not j.payload.get("replacementPlan") for j in previous
                ) and not plan.intent.get("allowDuplicate"):
                    raise DomainError(409, "原提交仍需核对，不能自动重发")
                if plan.intent.get("allowDuplicate"):
                    # 人工明确另行生成后，原未知记录仍可审计，但不永久阻塞后续补缺失。
                    for old in previous:
                        if old.state in UNCERTAIN and not old.payload.get("replacementPlan"):
                            old.payload = {
                                **old.payload,
                                "replacementPlan": plan.id,
                                "replacementReason": plan.intent.get("reason", ""),
                            }
                if plan.project and plan.intent.get("mode") in {"missing", "failed"}:
                    current = candidate_state(item["kind"], item["target"], item["payload"], jobs)
                    allowed = (
                        {"missing", "outdated"} if plan.intent["mode"] == "missing" else {"failed"}
                    )
                    if current["status"] not in allowed:
                        raise DomainError(409, "已有候选或任务状态已更新，请重新预检")
                payload = {
                    **item["payload"],
                    "owner": account.user_id,
                    "planId": plan.id,
                    "usageQuoteId": locked["id"],
                    "quotedPoints": locked["items"][len(rows)]["points"],
                    "inputHash": input_hash(item["kind"], item["payload"]),
                    "fingerprint": plan.request_hash,
                }
                if payload.get("quickDraft"):
                    # 候选编号在作品锁内分配，任务轮询、核对和重试都不改变展示顺序。
                    candidates = [
                        job
                        for job in [*jobs, *rows]
                        if job.kind == "video" and job.subject == item["target"]
                    ]
                    # 旧记录没有编号，界面仍稳定显示为 1..N；新编号必须从 N 后延续。
                    legacy = sum(not job.payload.get("quickSequence") for job in candidates)
                    payload["quickSequence"] = 1 + max(
                        legacy,
                        max(
                            (int(job.payload.get("quickSequence") or 0) for job in candidates),
                            default=0,
                        ),
                    )
                row = MediaJob(
                    id=identifier(),
                    owner=account.user_id,
                    project=plan.project,
                    library_entity=plan.entity,
                    revision=plan.revision,
                    request_key=plan.id,
                    subject=item["target"],
                    kind=item["kind"],
                    state="queued",
                    payload=payload,
                )
                dao.add(row)
                rows.append(row)
            await session.flush()
            plan.state = "confirmed"
            plan.result = {"jobs": [job_view(row) for row in rows], "usageQuote": locked}
            return plan.result
