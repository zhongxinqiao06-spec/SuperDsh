"""快速视频只裁剪交互范围，预检、冻结回执和队列仍走公共媒体用例。"""

from typing import TYPE_CHECKING, Any, cast

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.quick_dao import QuickDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.production import ACTIVE, UNCERTAIN, candidate_state
from app.modules.studio.entity.vo.production_vo import ConfirmPlan
from app.modules.studio.entity.vo.quick_vo import QuickDraft, QuickIntent
from app.modules.studio.entity.vo.studio_vo import Shot
from app.modules.studio.service.foundation_service import authorize
from app.modules.studio.service.generation_inputs import GenerationInputs
from app.modules.studio.service.generation_plan_service import GenerationPlans

if TYPE_CHECKING:
    from app.modules.studio.service.media_jobs import MediaJobs


class QuickGenerationService:
    def __init__(self, media: "MediaJobs") -> None:
        self.media = media
        self.plans = GenerationPlans(media)

    async def capabilities(self, account: Account) -> dict:
        """返回当前已配置视频适配支持的选择；不暴露连接或虚构首帧能力。"""
        authorize(account, "projects.read")
        if "models.use" not in account.permissions:
            return {"models": [], "defaultConfigurationId": None}
        catalog = cast(dict[str, Any], await self.media.models.catalog(account, "entertainment"))
        models = []
        for configuration in catalog["configurations"]:
            if configuration["capability"] != "video.generate":
                continue
            reference = configuration["parameters"].get("inputMode") == "reference"
            models.append(
                {
                    "id": configuration["id"],
                    "name": configuration["name"],
                    "inputModes": ["image", "reference"] if reference else ["text"],
                    "durations": list(range(3, 16)),
                    "aspects": ["16:9", "9:16", "1:1", "4:3", "3:4"],
                    "resolutions": ["720P"],
                    "maxReferences": 9 if reference else 0,
                }
            )
        default = next(
            (
                item["configurationId"]
                for item in catalog["defaults"]
                if item["capability"] == "video.generate"
            ),
            None,
        )
        return {"models": models, "defaultConfigurationId": default}

    async def inspect(self, account: Account, project_id: str, body: QuickIntent) -> dict:
        """读取已保存草稿并冻结一条视频；检查期间不创建任务、不请求供应商。"""
        authorize(account, "projects.write")
        account.require("models.use")
        async with self.media.database.sessions() as session:
            project = await StudioDao(session).project(account.user_id, project_id)
            if project.creation_mode != "quick" or project.lifecycle != "active":
                raise DomainError(409, "请打开正在创作的快速作品")
            if project.revision != body.revision:
                raise DomainError(409, "草稿已更新，请重新载入后预检")
            draft = QuickDraft.model_validate(project.quick_draft)
            if draft.references:
                account.require("studio.assets.read")
            assets = await QuickDao(session).references(
                account.user_id, project_id, draft.references
            )
            jobs = await QuickDao(session).candidates(project_id)
        if body.allowDuplicate and not body.reason.strip():
            raise DomainError(422, "另行生成前请说明已核对的情况及重复执行原因")
        target = "quick_" + project_id
        issues = []
        payload: dict = {}
        state = {"status": "blocked", "job": None}
        try:
            if not draft.prompt.strip():
                raise DomainError(422, "请先写下视频内容，再开始生成")
            if draft.inputMode == "text" and draft.references:
                raise DomainError(422, "文生视频不使用参考图，请切换模式或移除参考")
            if draft.inputMode == "image" and len(draft.references) != 1:
                raise DomainError(422, "单图生成需要恰好一张参考图")
            if draft.inputMode == "reference" and not draft.references:
                raise DomainError(422, "参考生视频至少需要一个参考形象或图片")
            if len(assets) != len(draft.references):
                raise DomainError(422, "参考素材不可读取，请重新选择本人素材版本")
            if any(
                a.definition["kind"] not in {"character", "scene", "prop", "image"}
                or not a.definition.get("fileId")
                for a in assets
            ):
                raise DomainError(422, "参考素材需要已有图片的角色、场景、道具或图片")
            catalog = await self.media.models.catalog(account, "entertainment")
            width, height = (int(part) for part in draft.aspect.split(":"))
            payload = await GenerationInputs(self.media, account, catalog).video(
                Shot(
                    id=target,
                    action=draft.prompt,
                    duration=draft.durationSeconds * 1000,
                    references=draft.references,
                ).model_dump(),
                {asset.id: asset.definition for asset in assets},
                {"video": draft.configurationId, "referenceVideo": draft.configurationId},
                {"aspectWidth": width, "aspectHeight": height},
            )
            payload["quickDraft"] = draft.model_dump()
            state = candidate_state("video", target, payload, jobs)
            if state["status"] == "ready" and not body.regenerate:
                issues.append(
                    {
                        "target": target,
                        "message": "已有相同参数的完成候选，可先预览；需要新结果时请明确选择再生成一个候选",
                    }
                )
            if any(job.state in ACTIVE for job in jobs):
                issues.append(
                    {"target": target, "message": "这部快速作品已有生成任务，请等待完成或先取消"}
                )
            if (
                any(
                    job.state in UNCERTAIN and not job.payload.get("replacementPlan")
                    for job in jobs
                )
                and not body.allowDuplicate
            ):
                issues.append({"target": target, "message": "上次提交仍待核对，请先处理任务回执"})
        except DomainError as exc:
            issues.append({"target": target, "message": exc.detail})
        return {
            "revision": body.revision,
            "items": [
                {
                    "target": target,
                    "shot": target,
                    "kind": "video",
                    "label": "一条快速视频",
                    "selected": True,
                    **state,
                    "model": payload.get("modelName", ""),
                    "seconds": draft.durationSeconds,
                    "references": len(draft.references),
                    "characters": 0,
                    "payload": payload,
                }
            ],
            "issues": issues,
        }

    async def prepare(self, account: Account, project: str, body: QuickIntent) -> dict:
        authorize(account, "projects.write")
        account.require("models.use")
        previous = await self.plans.replay(account, project, None, body.model_dump())
        if previous:
            return previous
        manifest = await self.inspect(account, project, body)
        return await self.plans.store(account, project, None, body.model_dump(), manifest)

    async def confirm(
        self, account: Account, project: str, plan_id: str, body: ConfirmPlan
    ) -> dict:
        """公共确认再次检查冻结输入；同一计划的重试始终返回同一个任务。"""
        authorize(account, "projects.write")
        account.require("models.use")
        plan = await self.plans.read(account, plan_id, project, None)
        if not plan.manifest["items"] or "quickDraft" not in plan.manifest["items"][0].get(
            "payload", {}
        ):
            raise DomainError(422, "此计划不属于快速创作或尚未通过预检")
        rebuilt = (
            plan.manifest
            if plan.state == "confirmed"
            else await self.inspect(account, project, QuickIntent.model_validate(plan.intent))
        )
        return await self.plans.confirm(account, plan_id, body, rebuilt)
