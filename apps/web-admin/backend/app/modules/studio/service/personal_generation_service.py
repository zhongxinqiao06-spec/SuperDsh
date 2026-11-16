"""个人角色/场景直接制作，复用模型、媒体队列和素材版本，不创建隐藏作品。"""

from typing import TYPE_CHECKING, Any, cast

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.asset_dao import AssetDao
from app.modules.studio.dao.production_dao import ProductionDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.do.production_do import JobAction
from app.modules.studio.entity.vo.production_vo import ConfirmPlan, PersonalAdopt, PersonalIntent
from app.modules.studio.entity.vo.studio_vo import AssetInput, identifier
from app.modules.studio.service.generation_inputs import GenerationInputs
from app.modules.studio.service.generation_plan_service import GenerationPlans
from app.modules.studio.service.studio_service import asset_view, job_view

if TYPE_CHECKING:
    from app.modules.studio.service.media_jobs import MediaJobs


class PersonalGenerationService:
    def __init__(self, media: "MediaJobs") -> None:
        self.media = media
        self.plans = GenerationPlans(media)

    async def state(self, account: Account, entity: str) -> dict:
        account.require("products.entertainment")
        account.require("studio.assets.read")
        async with self.media.database.sessions() as session:
            dao = ProductionDao(session)
            record = await dao.entity(account.user_id, entity)
            asset = await StudioDao(session).owned_asset(account.user_id, record.current_version_id)
            return {
                "revision": record.revision,
                "asset": asset_view(asset),
                "jobs": [job_view(j) for j in await dao.personal_jobs(account.user_id, entity)],
            }

    async def inspect(self, account: Account, entity: str, body: PersonalIntent) -> dict:
        account.require("studio.assets.write")
        account.require("models.use")
        state = await self.state(account, entity)
        if state["revision"] != body.revision:
            raise DomainError(409, "个人设定已更新，请重新预检")
        asset = state["asset"]
        catalog = cast(dict[str, Any], await self.media.models.catalog(account, "entertainment"))
        inputs = GenerationInputs(self.media, account, catalog)
        if body.kind == "voice":
            if asset["kind"] != "character":
                raise DomainError(422, "只有角色可以选择声音")
            payload = await inputs.speech(
                body.text, body.voice or asset.get("voice", ""), body.configuration
            )
            kind = "speech"
        else:
            payload = await inputs.reference(asset, body.model_dump())
            kind = "image"
        payload.update(purpose=body.kind, family=entity, sourceVersion=asset["id"])
        issues = []
        if body.allowDuplicate and not body.reason.strip():
            raise DomainError(422, "请说明核对依据与重新生成原因")
        if any(
            j["kind"] == kind
            and (
                j["state"] in {"queued", "submitting", "polling", "downloading"}
                or (
                    j["state"] in {"unknown", "paused", "unaccepted"}
                    and not body.allowDuplicate
                    and not j.get("replacementPlan")
                )
            )
            for j in state["jobs"]
        ):
            issues.append(
                {"target": entity, "message": "该设定仍有未结束或待核对任务，请先处理已有任务"}
            )
        return {
            "revision": body.revision,
            "issues": issues,
            "items": [
                {
                    "target": asset["id"],
                    "kind": kind,
                    "label": asset["name"],
                    "model": payload["modelName"],
                    "voice": payload.get("voice"),
                    "characters": len(payload.get("text", "")),
                    "references": len(payload.get("images", [])),
                    "selected": True,
                    "status": "missing",
                    "payload": payload,
                }
            ],
        }

    async def prepare(self, account: Account, entity: str, body: PersonalIntent) -> dict:
        account.require("products.entertainment")
        account.require("studio.assets.write")
        account.require("models.use")
        previous = await self.plans.replay(account, None, entity, body.model_dump())
        if previous:
            return previous
        manifest = await self.inspect(account, entity, body)
        return await self.plans.store(account, None, entity, body.model_dump(), manifest)

    async def confirm(
        self, account: Account, entity: str, identity: str, body: ConfirmPlan
    ) -> dict:
        account.require("products.entertainment")
        account.require("studio.assets.write")
        account.require("models.use")
        plan = await self.plans.read(account, identity, None, entity)
        manifest = (
            plan.manifest
            if plan.state == "confirmed"
            else await self.inspect(account, entity, PersonalIntent.model_validate(plan.intent))
        )
        return await self.plans.confirm(account, identity, body, manifest)

    async def adopt(self, account: Account, entity: str, body: PersonalAdopt) -> dict:
        account.require("products.entertainment")
        account.require("studio.assets.write")
        await self.state(account, entity)
        async with self.media.database.sessions() as session:
            job = await ProductionDao(session).job(body.job)
            if (
                job.project is not None
                or job.owner != account.user_id
                or job.library_entity != entity
            ):
                raise DomainError(404, "候选不属于该个人设定")
        path, mime = await self.media.file(account, None, body.job)
        file_id = (
            str((await self.media.studio.files.ingest_media(account, job.id, path, mime))["id"])
            if job.kind == "image"
            else None
        )
        async with self.media.database.sessions.begin() as session:
            dao = ProductionDao(session)
            await AssetDao(session).lock_family(entity)
            record = await dao.entity(account.user_id, entity, lock=True)
            fingerprint = content_hash({"entity": entity, **body.model_dump()})
            previous = await dao.action(account.user_id, body.requestKey)
            if previous:
                if previous.request_hash != fingerprint:
                    raise DomainError(409, "请求号已用于其它采用操作")
                return previous.result
            if record.revision != body.revision:
                raise DomainError(409, "设定已更新，请核对最新版本后再采用")
            source = await StudioDao(session).owned_asset(
                account.user_id, record.current_version_id
            )
            values = {k: v for k, v in source.definition.items() if k in AssetInput.model_fields}
            values.update(parent=source.id, project=None)
            if job.kind == "image":
                values["fileId"] = file_id
            else:
                values["voice"] = job.payload["voice"]
            created = await self.media.studio.asset_versions.create(
                session, account, AssetInput.model_validate(values), origin=job.id
            )
            if job.kind == "speech":
                version = await AssetDao(session).entity_version(created)
                if not version:
                    raise DomainError(409, "新声音版本不可用")
                version.voice_configuration_id = job.payload["binding"]["configurationId"]
                version.voice_configuration_revision = job.payload["binding"]["revision"]
                version.voice_parameters = {"previewJob": job.id, "text": job.payload["text"]}
            result = {"asset": created, "revision": record.revision}
            dao.add(
                JobAction(
                    id=identifier(),
                    owner=account.user_id,
                    job=job.id,
                    request_key=body.requestKey,
                    request_hash=fingerprint,
                    kind="personal.adopt",
                    detail={"entity": entity},
                    result=result,
                )
            )
            return result
