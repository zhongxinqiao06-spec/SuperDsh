"""造型、分镜图和音色试听复用持久媒体任务；预检不生成，采用独立保存。"""

from typing import TYPE_CHECKING, Any, cast

from app.infrastructure.errors import DomainError
from app.modules.billing.service.quote_service import lock_plan_quote
from app.modules.billing.service.usage_credit import chargeable_points, reserve_jobs
from app.modules.identity.entity.bo.models import Account
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.models.service.image_protocol import supports_reference_images
from app.modules.studio.dao.asset_dao import AssetDao
from app.modules.studio.dao.foundation_dao import FoundationDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.do.foundation_do import StudioCommand
from app.modules.studio.entity.do.models import MediaJob
from app.modules.studio.entity.vo.preparation_vo import AdoptPreparation, PreparationJob
from app.modules.studio.entity.vo.studio_vo import AssetInput, identifier
from app.modules.studio.service.plan_pricing import quote_manifest
from app.modules.studio.service.series_access_service import assert_episode_editable

if TYPE_CHECKING:
    from app.modules.studio.service.media_jobs import MediaJobs


class PreparationMediaService:
    def __init__(self, media: "MediaJobs") -> None:
        self.media = media

    async def submit(
        self, account: Account, project_id: str, body: PreparationJob, *, preview: bool = False
    ) -> dict:
        """预检返回可确认摘要；确认时核对相同输入后写入唯一任务，不直接调用模型。"""
        from app.modules.studio.service.studio_service import job_view

        account.require("products.entertainment")
        account.require("studio.projects.write")
        account.require("studio.assets.read")
        account.require("models.use")
        capability = "speech.synthesize" if body.kind == "voice" else "image.generate"
        catalog = cast(dict[str, Any], await self.media.models.catalog(account, "entertainment"))
        chosen = body.configuration or next(
            (d["configurationId"] for d in catalog["defaults"] if d["capability"] == capability),
            None,
        )
        config = next(
            (
                c
                for c in catalog["configurations"]
                if c["id"] == chosen and c["capability"] == capability
            ),
            None,
        )
        if not config:
            raise DomainError(
                422, "请先配置当前产品可用的" + ("配音模型" if body.kind == "voice" else "图片模型")
            )
        binding = {
            "configurationId": config["id"],
            "revision": config["revision"],
            "capability": capability,
        }
        resolved = cast(
            dict[str, Any],
            await self.media.models.resolve(
                account, CapabilityBinding.model_validate(binding), "entertainment"
            ),
        )
        fingerprint = content_hash(body.model_dump(exclude={"planHash"}))
        async with self.media.database.sessions.begin() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            if project.lifecycle == "archived":
                raise DomainError(409, "请先恢复作品")
            existing = next(
                (j for j in await dao.jobs(project) if j.request_key == body.requestKey), None
            )
            if existing:
                if existing.payload["fingerprint"] != fingerprint:
                    raise DomainError(409, "请求号已用于另一项制作")
                return {"job": job_view(existing)}
            if project.revision != body.revision:
                raise DomainError(409, "工程已更新，请重新确认试做范围")
            await assert_episode_editable(session, account, project)
            document = await self.media.studio.documents.read(session, project_id)
            assets = {
                a.id: a
                for a in await dao.assets(account.user_id, project_id)
                if a.id in document.assets
            }
            target = assets.get(body.target)
            shot = next((s for s in document.shots if s.id == body.target), None)
            images: list[str] = []
            if body.kind == "storyboard":
                if not shot:
                    raise DomainError(404, "镜头不存在")
                scene = next((s for s in document.scenes if s.id == shot.sceneId), None)
                scene_asset = shot.sceneAssetId or (scene.sceneAssetId if scene else None)
                references = [
                    assets[ref].definition
                    for ref in dict.fromkeys(
                        [
                            *shot.references,
                            *(line.role for line in shot.lines),
                            *([scene_asset] if scene_asset else []),
                        ]
                    )
                ]
                prompt = "\n".join(
                    [
                        project.style_brief,
                        shot.scene,
                        shot.action,
                        shot.framing,
                        shot.camera,
                        shot.movement,
                        *[str(a.get("description", "")) for a in references],
                        body.prompt,
                    ]
                )
                images = [
                    str(a["fileId"])
                    for a in references
                    if a.get("fileId") and a["kind"] in {"character", "scene", "prop", "image"}
                ]
                title, family = "分镜参考画面", None
            else:
                if not target or target.definition["kind"] not in {"character", "scene", "prop"}:
                    raise DomainError(404, "请先把角色或场景加入当前作品")
                title, family = target.definition["name"], target.family
                prompt = "\n".join(
                    [
                        project.style_brief,
                        title,
                        target.definition.get("description", ""),
                        body.prompt,
                    ]
                )
                images = [target.definition["fileId"]] if target.definition.get("fileId") else []
            if body.kind == "voice":
                if not target or target.definition["kind"] != "character":
                    raise DomainError(422, "只有角色可以试听音色")
                voice = body.voice or target.definition.get("voice", "")
                if (
                    voice not in config["parameters"].get("voices", "").split(",")
                    or not body.text.strip()
                ):
                    raise DomainError(422, "请选择所选模型支持的音色，并输入要试听的台词")
                payload = {"text": body.text, "voice": voice}
            else:
                if not body.useReference:
                    images = []
                if images and not supports_reference_images(
                    resolved["connection"]["adapter"], config["parameters"]
                ):
                    raise DomainError(422, "所选图片连接不支持参考图编辑，请换模型或取消沿用参考图")
                if len(images) > config["parameters"].get("maxImages", 1):
                    raise DomainError(
                        422, "参考图数量超过所选模型上限，请调整镜头引用或取消沿用参考图"
                    )
                payload = {"prompt": prompt, "images": images}
            # 文件校验发生在预检与提交两处，执行前还会再次鉴权。
            for file_id in images if body.kind != "voice" else []:
                entry = await self.media.studio.files.entry(account, file_id)
                if (
                    entry["mediaType"] not in {"image/png", "image/jpeg", "image/webp"}
                    or int(str(entry["size"])) > 20 * 1024 * 1024
                ):
                    raise DomainError(422, "参考图须为不超过 20 MB 的图片")
            payload.update(
                {
                    "binding": binding,
                    "purpose": body.kind,
                    "family": family,
                    "sourceVersion": body.target,
                    "owner": account.user_id,
                    "fingerprint": fingerprint,
                    "title": title,
                }
            )
            plan = {
                "title": title,
                "kind": body.kind,
                "model": config["name"],
                "binding": binding,
                "text": body.text if body.kind == "voice" else prompt,
                "voice": payload.get("voice"),
                "references": len(images) if body.kind != "voice" else 0,
                "revision": project.revision,
                "estimatedCost": None,
            }
            kind = "speech" if body.kind == "voice" else "image"
            identity = content_hash(
                {"project": project_id, "request": body.requestKey, "fingerprint": fingerprint}
            )
            priced = await quote_manifest(
                session,
                account.user_id,
                identity,
                {
                    "issues": [],
                    "items": [
                        {"selected": True, "kind": kind, "target": body.target, "payload": payload}
                    ],
                },
            )
            quote = priced["usageQuote"]
            charge = chargeable_points(quote["totalPoints"], unlimited=quote["unlimited"])
            if quote["unlimited"]:
                plan["unlimited"] = True
            plan["quotedPoints"] = charge
            digest = content_hash({"plan": plan, "payload": payload, "quote": quote["id"]})
            if preview:
                return {"plan": plan, "planHash": digest}
            if digest != body.planHash:
                raise DomainError(409, "作品或模型已变化，请重新预检并确认")
            await lock_plan_quote(session, account.user_id, identity, quote["id"])
            job = MediaJob(
                id=identifier(),
                project=project_id,
                revision=project.revision,
                request_key=body.requestKey,
                subject=body.target,
                kind=kind,
                state="queued",
                payload={
                    **payload,
                    "creditMetered": True,
                    "usageQuoteId": quote["id"],
                    "quotedPoints": charge,
                },
            )
            session.add(job)
            await reserve_jobs(session, account.user_id, [(job.id, charge)])
            await session.flush()
            return {"job": job_view(job)}

    async def adopt(self, account: Account, project_id: str, body: AdoptPreparation) -> dict:
        """将本人作品的成功候选保存为新素材版本，只替换指定目标的引用。"""
        account.require("products.entertainment")
        account.require("studio.projects.write")
        account.require("studio.assets.write")
        path, mime = await self.media.file(account, project_id, body.job)
        file_id = None
        if mime == "image/png":
            file_id = str(
                (await self.media.studio.files.ingest_media(account, body.job, path, mime))["id"]
            )
        async with self.media.database.sessions.begin() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            commands = FoundationDao(session)
            fingerprint = content_hash(body.model_dump())
            prior = await commands.command(account.user_id, project_id, body.requestKey)
            if prior:
                if prior.request_hash != fingerprint:
                    raise DomainError(409, "采用请求号已用于其他内容")
                return prior.result
            if project.lifecycle == "archived" or project.revision != body.revision:
                raise DomainError(409, "工程已更新，请重新选择采用目标")
            await assert_episode_editable(session, account, project)
            job = await dao.locked_job(project, body.job)
            purpose = job.payload.get("purpose")
            document = await self.media.studio.documents.read(session, project_id)
            if purpose == "storyboard":
                shot = next((s for s in document.shots if s.id == body.target == job.subject), None)
                if not shot or not file_id:
                    raise DomainError(422, "分镜图与镜头不匹配")
                created = await self.media.studio.asset_versions.create(
                    session,
                    account,
                    AssetInput(kind="image", name="分镜参考", fileId=file_id, project=project_id),
                    origin=job.id,
                )
                # 替换该镜先前采用的分镜图，人物/场景参考及其它镜头继续保留。
                assets = {a.id: a for a in await dao.assets(account.user_id, project_id)}
                origins = {
                    j.id
                    for j in await dao.jobs(project)
                    if j.subject == body.target and j.payload.get("purpose") == "storyboard"
                }
                shot.references = [
                    ref
                    for ref in shot.references
                    if assets[ref].definition.get("sourceJob") not in origins
                ] + [created]
                document.assets.append(created)
            elif purpose in {"reference", "voice"}:
                source = await dao.owned_asset(account.user_id, body.target)
                if source.id not in document.assets or source.family != job.payload.get("family"):
                    raise DomainError(422, "候选不属于所选角色或场景")
                values = {
                    k: v for k, v in source.definition.items() if k in AssetInput.model_fields
                }
                values.update({"parent": source.id, "project": project_id})
                if purpose == "reference":
                    values["fileId"] = file_id
                else:
                    values["voice"] = job.payload["voice"]
                created = await self.media.studio.asset_versions.create(
                    session, account, AssetInput.model_validate(values), origin=job.id
                )
                if purpose == "voice":
                    record = await AssetDao(session).entity_version(created)
                    if record is None:
                        raise DomainError(409, "角色版本不可用")
                    record.voice_configuration_id = job.payload["binding"]["configurationId"]
                    record.voice_configuration_revision = job.payload["binding"]["revision"]
                    record.voice_parameters = {"previewJob": job.id, "text": job.payload["text"]}
                document.assets = list(
                    dict.fromkeys(created if ref == source.id else ref for ref in document.assets)
                )
                for scene in document.scenes:
                    if scene.sceneAssetId == source.id:
                        scene.sceneAssetId = created
                for shot in document.shots:
                    if shot.sceneAssetId == source.id:
                        shot.sceneAssetId = created
                    shot.references = [
                        created if ref == source.id else ref for ref in shot.references
                    ]
                    for line in shot.lines:
                        if line.role == source.id:
                            line.role = created
            else:
                raise DomainError(422, "此任务不是创作准备候选")
            await self.media.studio.documents.persist(
                session, account, project, document, "采用创作准备候选"
            )
            result = {"revision": project.revision, "asset": created}
            commands.remember(
                StudioCommand(
                    id=identifier(),
                    owner_id=account.user_id,
                    project_id=project_id,
                    operation_key=body.requestKey,
                    request_hash=fingerprint,
                    command_type="preparation.adopt",
                    result=result,
                )
            )
            return result
