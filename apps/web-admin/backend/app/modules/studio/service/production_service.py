"""逐镜预检和按缺失/失败范围制作，浏览器与既有导演工具复用同一用例。"""

from typing import TYPE_CHECKING, Any, cast

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.production import candidate_state
from app.modules.studio.entity.vo.production_vo import ConfirmPlan, ProductionIntent
from app.modules.studio.entity.vo.studio_vo import Batch
from app.modules.studio.service.document_service import brief_view
from app.modules.studio.service.generation_inputs import GenerationInputs
from app.modules.studio.service.generation_plan_service import GenerationPlans

if TYPE_CHECKING:
    from app.modules.studio.service.media_jobs import MediaJobs


class ProductionService:
    def __init__(self, media: "MediaJobs") -> None:
        self.media = media
        self.plans = GenerationPlans(media)

    async def inspect(self, account: Account, project_id: str, body: ProductionIntent) -> dict:
        """返回每个镜头/台词的明确预检结果；失败不创建任何媒体任务。"""
        account.require("products.entertainment")
        account.require("studio.projects.write")
        account.require("models.use")
        async with self.media.database.sessions() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id)
            if project.revision != body.revision or project.lifecycle == "archived":
                raise DomainError(409, "工程已更新或归档，请重新读取")
            document = (await self.media.studio.documents.read(session, project_id)).model_dump()
            assets = {a.id: a.definition for a in await dao.assets(account.user_id, project_id)}
            jobs = await dao.jobs(project)
            brief = brief_view(project)
        catalog = cast(dict[str, Any], await self.media.models.catalog(account, "entertainment"))
        inputs = GenerationInputs(self.media, account, catalog)
        items, issues = [], []
        intent = body.model_dump()
        allowed = {s["id"] for s in document["shots"]} | {
            line["id"] for s in document["shots"] for line in s["lines"]
        }
        if set([*body.shots, *body.lines]) - allowed:
            raise DomainError(422, "所选镜头或台词已不存在")
        if body.allowDuplicate and not body.reason.strip():
            raise DomainError(422, "承担重复执行风险需说明原因")
        for position, shot in enumerate(document["shots"], 1):
            # 镜头明确选择优先，否则继承所属场次；只冻结本次输入，不改写工程。
            scene: dict = next((s for s in document["scenes"] if s["id"] == shot["sceneId"]), {})
            shot = {**shot, "sceneAssetId": shot.get("sceneAssetId") or scene.get("sceneAssetId")}
            targets = [("video", shot["id"], f"镜 {position} · {shot['action']}", shot)]
            targets += [
                ("speech", line["id"], f"镜 {position} · {line['text']}", line)
                for line in shot["lines"]
            ]
            for kind, target, label, source in targets:
                if body.mode == "selected" and target not in (
                    body.shots if kind == "video" else body.lines
                ):
                    continue
                try:
                    adopted_asset = source.get(
                        "videoAssetId" if kind == "video" else "audioAssetId"
                    )
                    if adopted_asset and body.mode in {"missing", "failed"}:
                        items.append(
                            {
                                "target": target,
                                "shot": shot["id"],
                                "kind": kind,
                                "label": label,
                                "selected": False,
                                "status": "ready",
                                "message": "已使用媒体库素材",
                                "model": "媒体库",
                                "payload": {},
                            }
                        )
                        continue
                    if kind == "video":
                        payload = await inputs.video(source, assets, intent, brief)
                    else:
                        role = assets[source["role"]]
                        payload = await inputs.speech(
                            source["text"],
                            source["voice"] or role.get("voice", ""),
                            body.speech,
                            role.get("voiceBinding") if not source["voice"] else None,
                        )
                    state = candidate_state(kind, target, payload, jobs)
                    status = state["status"]
                    selected = (
                        body.mode in {"all", "selected"}
                        or (body.mode == "missing" and status in {"missing", "outdated"})
                        or (body.mode == "failed" and status == "failed")
                    )
                    if status == "active":
                        selected = False
                    if status == "uncertain" and selected and not body.allowDuplicate:
                        issues.append({"target": target, "message": "原提交待核对，不能再次提交"})
                    items.append(
                        {
                            "target": target,
                            "shot": shot["id"],
                            "kind": kind,
                            "label": label,
                            "selected": selected,
                            **state,
                            "model": payload["modelName"],
                            "seconds": payload.get("seconds"),
                            "characters": len(payload.get("text", "")),
                            "voice": payload.get("voice"),
                            "references": len(payload.get("images", [])),
                            "payload": payload,
                        }
                    )
                except DomainError as exc:
                    # 无关的失败项不阻挡用户本次只补失败/缺失；选定范围内保留定位信息。
                    previous = next(
                        (j for j in jobs if j.subject == target and j.kind == kind), None
                    )
                    needed = (
                        body.mode in {"all", "selected"}
                        or (
                            body.mode == "failed"
                            and previous is not None
                            and previous.state == "failed"
                        )
                        or (
                            body.mode == "missing"
                            and (previous is None or previous.state == "cancelled")
                        )
                    )
                    items.append(
                        {
                            "target": target,
                            "shot": shot["id"],
                            "kind": kind,
                            "label": label,
                            "selected": needed,
                            "status": "blocked",
                            "message": exc.detail,
                            "model": "",
                            "payload": {},
                        }
                    )
                    if needed:
                        issues.append({"target": target, "message": exc.detail})
        return {"revision": body.revision, "items": items, "issues": issues}

    async def prepare(self, account: Account, project: str, body: ProductionIntent) -> dict:
        account.require("products.entertainment")
        account.require("studio.projects.write")
        account.require("models.use")
        previous = await self.plans.replay(account, project, None, body.model_dump())
        if previous:
            return previous
        manifest = await self.inspect(account, project, body)
        return await self.plans.store(account, project, None, body.model_dump(), manifest)

    async def confirm(
        self, account: Account, project: str, plan_id: str, body: ConfirmPlan
    ) -> dict:
        account.require("products.entertainment")
        account.require("studio.projects.write")
        account.require("models.use")
        plan = await self.plans.read(account, plan_id, project, None)
        if plan.state == "confirmed":
            return await self.plans.confirm(account, plan_id, body, plan.manifest)
        rebuilt = await self.inspect(account, project, ProductionIntent.model_validate(plan.intent))
        return await self.plans.confirm(account, plan_id, body, rebuilt)

    async def legacy(
        self, account: Account, project: str, batch: Batch, preview: bool, approved_hash: str | None
    ) -> list[dict]:
        """旧工作台/DSH 的确认契约映射到同一预检及冻结计划，不保留第二套生成规则。"""
        body = ProductionIntent(
            revision=batch.revision,
            requestKey=batch.requestKey,
            mode="selected",
            shots=batch.shots,
            lines=batch.lines,
            video=batch.video,
            referenceVideo=batch.referenceVideo,
            speech=batch.speech,
        )
        account.require("products.entertainment")
        account.require("studio.projects.write")
        account.require("models.use")
        previous = await self.plans.replay(account, project, None, body.model_dump())
        if previous and previous["state"] == "confirmed" and not preview:
            return previous["result"]["jobs"]
        manifest = await self.inspect(account, project, body)
        if manifest["issues"]:
            raise DomainError(422, "；".join(i["message"] for i in manifest["issues"]))
        rows = [
            {
                "kind": item["kind"],
                "target": item["target"],
                "project": project,
                "revision": body.revision,
                "model": item["payload"]["binding"],
                "seconds": item.get("seconds"),
                "characters": item["characters"],
                "voice": item.get("voice"),
            }
            for item in manifest["items"]
        ]
        if preview:
            return rows
        if approved_hash and approved_hash != self.media.plan_hash(rows):
            raise DomainError(409, "制作范围已变化，请重新确认")
        planned = await self.plans.store(account, project, None, body.model_dump(), manifest)
        result = await self.confirm(
            account,
            project,
            planned["id"],
            ConfirmPlan(
                revision=body.revision, requestKey=batch.requestKey, planHash=planned["planHash"]
            ),
        )
        return result["jobs"]
