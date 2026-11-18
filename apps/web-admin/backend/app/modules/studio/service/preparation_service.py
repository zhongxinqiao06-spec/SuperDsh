"""阶段检查和确认与当前工程核对，保存不可变指纹供后续修改失效提示。"""

from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.foundation_dao import FoundationDao
from app.modules.studio.dao.preparation_dao import PreparationDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.bo.preparation_state import (
    STAGES,
    preparation_inputs,
    preparation_issues,
)
from app.modules.studio.entity.do.foundation_do import StudioCommand
from app.modules.studio.entity.do.preparation_do import StageReview
from app.modules.studio.entity.vo.preparation_vo import ConfirmStage, Stage
from app.modules.studio.entity.vo.studio_vo import identifier
from app.modules.studio.service.document_service import brief_view

if TYPE_CHECKING:
    from app.modules.studio.service.studio_service import StudioService


class PreparationService:
    def __init__(self, studio: "StudioService") -> None:
        self.studio = studio

    async def state(self, account: Account, project_id: str) -> dict:
        """返回本人作品的检查项与确认状态，不把其它字段更新误判为全流程失效。"""
        account.require("products.entertainment")
        account.require("studio.projects.read")
        async with self.studio.database.sessions() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id)
            document = (await self.studio.documents.read(session, project_id)).model_dump()
            assets = [
                {**a.definition, "id": a.id} for a in await dao.assets(account.user_id, project_id)
            ]
            jobs = [{"id": j.id, "state": j.state} for j in await dao.jobs(project)]
            inputs = preparation_inputs(document, assets, jobs, brief_view(project))
            issues = preparation_issues(document, assets, jobs)
            reviews = await PreparationDao(session).reviews(project_id)
            stages = []
            for stage, title in STAGES.items():
                review = next((r for r in reviews if r.stage == stage), None)
                current = content_hash(inputs[stage])
                status = (
                    (review.decision if review.input_hash == current else "stale")
                    if review
                    else (
                        "blocked"
                        if any(not i["waivable"] for i in issues[stage])
                        else "needs_review"
                    )
                )
                stages.append(
                    {
                        "key": stage,
                        "title": title,
                        "status": status,
                        "issues": issues[stage],
                        "review": {
                            "revision": review.project_revision,
                            "reason": review.reason,
                            "decision": review.decision,
                            "createdAt": review.created_at.isoformat(),
                        }
                        if review
                        else None,
                    }
                )
            return {"revision": project.revision, "stages": stages}

    async def confirm(
        self, account: Account, project_id: str, stage: Stage, body: ConfirmStage
    ) -> dict:
        """确认当前输入；重复操作复用回执，可选项略过和试片跳过保留理由。"""
        account.require("products.entertainment")
        account.require("studio.projects.write")
        async with self.studio.database.sessions.begin() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            commands = FoundationDao(session)
            fingerprint = content_hash({"stage": stage, **body.model_dump()})
            previous = await commands.command(account.user_id, project_id, body.requestKey)
            if previous:
                if previous.request_hash != fingerprint:
                    raise DomainError(409, "确认请求号已用于其他内容")
                return previous.result
            if project.revision != body.revision or project.lifecycle == "archived":
                raise DomainError(409, "作品已更新或归档，请重新检查")
            doc = (await self.studio.documents.read(session, project_id)).model_dump()
            assets = [
                {**a.definition, "id": a.id} for a in await dao.assets(account.user_id, project_id)
            ]
            jobs = await dao.jobs(project)
            inputs = preparation_inputs(doc, assets, [], brief_view(project))
            issues = preparation_issues(
                doc, assets, [{"id": j.id, "state": j.state} for j in jobs]
            )[stage]
            if body.decision == "skipped":
                if stage != "sample" or not body.reason.strip():
                    raise DomainError(422, "仅代表镜头试做允许跳过，并须记录理由")
            else:
                if not body.acknowledged:
                    raise DomainError(422, "请先审阅本阶段内容，再明确确认")
                allowed = {i["key"] for i in issues if i["waivable"]}
                if set(body.waived) - allowed or (body.waived and not body.reason.strip()):
                    raise DomainError(422, "略过项需要对应当前问题并填写理由")
                if any(i["key"] not in body.waived for i in issues):
                    raise DomainError(422, "请先处理检查项，或逐项明确略过可选素材")
                if stage == "sample":
                    selected = [s for s in doc["shots"] if s["id"] in body.shots]
                    ready = {j.id for j in jobs if j.state == "ready" and j.kind == "video"}
                    if (
                        not selected
                        or len(selected) != len(set(body.shots))
                        or any(
                            s.get("candidate") not in ready and not s.get("videoAssetId")
                            for s in selected
                        )
                    ):
                        raise DomainError(422, "请先采用并审看所选代表镜头的视频")
            record = StageReview(
                id=identifier(),
                project_id=project_id,
                stage=stage,
                project_revision=project.revision,
                input_hash=content_hash(inputs[stage]),
                decision=body.decision,
                reason=body.reason,
                selections={"waived": body.waived, "shots": body.shots},
                actor_id=account.user_id,
            )
            PreparationDao(session).add(record)
            result = {
                "id": record.id,
                "stage": stage,
                "status": body.decision,
                "revision": project.revision,
            }
            commands.remember(
                StudioCommand(
                    id=identifier(),
                    owner_id=account.user_id,
                    project_id=project_id,
                    operation_key=body.requestKey,
                    request_hash=fingerprint,
                    command_type="stage.confirm",
                    result=result,
                )
            )
            return result
