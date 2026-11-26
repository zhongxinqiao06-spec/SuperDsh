"""作品编辑与素材引用。网页和 DSH 工具共享相同的并发、归属和版本校验。"""

from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.files.service.file_service import FileService
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.asset_dao import AssetDao
from app.modules.studio.dao.directory_dao import DirectoryDao
from app.modules.studio.dao.foundation_dao import FoundationDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.do.foundation_do import StudioCommand
from app.modules.studio.entity.do.models import MediaJob, StudioAsset, StudioProject
from app.modules.studio.entity.vo.foundation_vo import ProjectBrief
from app.modules.studio.entity.vo.studio_vo import (
    AssetInput,
    Document,
    Review,
    SaveDocument,
    identifier,
)
from app.modules.studio.service.asset_service import StudioAssetService
from app.modules.studio.service.document_service import ProjectDocumentService, brief_view
from app.modules.studio.service.foundation_service import StudioFoundationService, apply_brief
from app.modules.studio.service.preparation_service import PreparationService
from app.modules.studio.service.proposal_service import ProposalService
from app.modules.studio.service.text_edit_service import TextEditService


def project_view(project: StudioProject) -> dict:
    return {
        **brief_view(project),
        "id": project.id,
        "title": project.title,
        "revision": project.revision,
        "proposal": project.proposal,
        "sessionId": project.session_id,
        "updated": project.updated.isoformat(),
    }


def job_view(row: MediaJob) -> dict:
    return {
        "id": row.id,
        "subject": row.subject,
        "kind": row.kind,
        "revision": row.revision,
        "state": row.state,
        "error": row.error,
        "binding": row.payload.get("binding"),
        "usageQuoteId": row.payload.get("usageQuoteId"),
        "quotedPoints": row.payload.get("quotedPoints"),
        "recoveryState": row.payload.get("recoveryState"),
        "hasReceipt": bool(row.provider_id),
        "cancelRequested": row.cancel_requested,
        "project": row.project,
        "entity": row.library_entity,
        "duration": row.payload.get("duration"),
        "purpose": row.payload.get("purpose"),
        "family": row.payload.get("family"),
        "sourceVersion": row.payload.get("sourceVersion"),
        "replacementPlan": row.payload.get("replacementPlan"),
        "voice": row.payload.get("voice"),
        "text": row.payload.get("text"),
        "updated": row.updated.isoformat(),
    }


def asset_view(row: StudioAsset) -> dict:
    return {
        **row.definition,
        "id": row.id,
        "family": row.family,
        "project": row.project,
        "parent": row.parent,
    }


def validate_document(document: Document, assets: list[StudioAsset], jobs: list[MediaJob]) -> None:
    """校验引用和候选的确切来源；采用动作不能把另一镜的结果挂入当前镜。"""
    catalog = {item.id: item for item in assets}
    adopted = {job.id: job for job in jobs if job.state == "ready"}
    linked = set(document.assets)

    def require_asset(identity: str | None, kinds: set[str], label: str) -> None:
        if identity and (
            identity not in linked
            or identity not in catalog
            or catalog[identity].definition["kind"] not in kinds
            or (kinds != {"scene"} and not catalog[identity].definition.get("fileId"))
        ):
            raise DomainError(422, label + "需要选择已加入本片的对应素材版本")

    if linked - catalog.keys() or (
        document.music
        and (
            document.music not in linked
            or catalog[document.music].definition["kind"] not in {"audio", "music"}
            or not catalog[document.music].definition.get("fileId")
        )
    ):
        raise DomainError(422, "工程引用了不可访问的素材")
    for scene in document.scenes:
        require_asset(scene.sceneAssetId, {"scene"}, "场次场景")
    for effect in document.soundEffects:
        require_asset(effect.assetId, {"audio", "music"}, "音效")
    for shot in document.shots:
        require_asset(shot.sceneAssetId, {"scene"}, "镜头场景")
        require_asset(shot.videoAssetId, {"video"}, "镜头画面")
        if set(shot.references) - linked:
            raise DomainError(422, "请先把参考素材加入作品")
        for line in shot.lines:
            require_asset(line.audioAssetId, {"audio"}, "台词配音")
            if line.role not in linked or catalog[line.role].definition["kind"] != "character":
                raise DomainError(422, "台词需要绑定作品角色")
        for target, selected, kind in [
            (shot.id, shot.candidate, "video"),
            *[(line.id, line.audio, "speech") for line in shot.lines],
        ]:
            if selected:
                job = adopted.get(selected)
                if not job or job.kind != kind or job.subject != target:
                    raise DomainError(422, "所选候选与镜头或台词不匹配")


def validate_media_trims(document: Document, durations: dict[str, int]) -> None:
    """使用已探测事实检查裁剪；台词超长允许保留待修，正式导出再阻断。"""
    for shot in document.shots:
        length = durations.get(shot.videoAssetId or "")
        if length and (shot.trimEnd or shot.duration) > length:
            raise DomainError(422, "镜头裁剪超过所选视频长度，请调整镜头时长")
    for effect in document.soundEffects:
        length = durations.get(effect.assetId)
        if length and (
            effect.trimStart >= length or (effect.trimEnd is not None and effect.trimEnd > length)
        ):
            raise DomainError(422, "音效裁剪超过所选音频长度")


class StudioService:
    def __init__(self, database: Database, files: FileService) -> None:
        self.database, self.files = database, files
        self.asset_versions = StudioAssetService(files)
        self.documents = ProjectDocumentService(self.asset_versions)
        self.foundation = StudioFoundationService(self)
        self.preparation = PreparationService(self)
        self.proposals = ProposalService(self)
        self.text_edits = TextEditService(self)

    async def list_projects(self, account: Account) -> list[dict]:
        account.require("products.entertainment")
        account.require("studio.projects.read")
        async with self.database.sessions() as session:
            return [
                {
                    **project_view(p),
                    "shots": len(doc["shots"]),
                    "adopted": sum(
                        bool(s.get("candidate") or s.get("videoAssetId")) for s in doc["shots"]
                    ),
                }
                for p, doc in await StudioDao(session).summaries(account.user_id)
            ]

    async def create(self, account: Account, title: str) -> dict:
        account.require("products.entertainment")
        account.require("studio.projects.write")
        async with self.database.sessions.begin() as session:
            project = StudioProject(id=identifier(), owner=account.user_id, title=title, revision=0)
            session.add(project)
            await session.flush()
            await self.documents.persist(session, account, project, Document(), "创建作品")
            await session.flush()
            await session.refresh(project)
            return project_view(project)

    async def project_page(
        self,
        account: Account,
        page: int,
        size: int,
        search: str,
        lifecycle: str = "active",
        mode: str = "all",
    ) -> dict:
        """作品目录仅返回当前版本的进度和入口，不读取整个工程历史。"""
        account.require("products.entertainment")
        account.require("studio.projects.read")
        async with self.database.sessions() as session:
            dao = DirectoryDao(session)
            rows, total = await dao.page(
                dao.projects(account.user_id, search, lifecycle, mode), page, size
            )
            return {"items": [dict(row._mapping) for row in rows], "total": total}

    async def asset_page(
        self,
        account: Account,
        page: int,
        size: int,
        scope: str,
        kind: str,
        search: str,
        category: str = "",
    ) -> dict:
        """个人库列出独立版本；作品库按作品显示其引用的具体版本。"""
        account.require("products.entertainment")
        account.require("studio.assets.read")
        async with self.database.sessions() as session:
            dao = DirectoryDao(session)
            rows, total = await dao.page(
                dao.assets(account.user_id, scope, kind, search, category), page, size
            )
            return {
                "items": [
                    {
                        **asset_view(row[0]),
                        "workId": row[1] if scope == "project" else None,
                        "workTitle": row[2] if scope == "project" else None,
                    }
                    for row in rows
                ],
                "total": total,
            }

    async def usage(
        self, account: Account, asset_id: str, project: str | None, page: int, size: int
    ) -> dict:
        """镜号按当前作品顺序显示，链接使用稳定 ID；同一素材的其它版本单独计算。"""
        account.require("products.entertainment")
        account.require("studio.assets.read")
        async with self.database.sessions() as session:
            studio = StudioDao(session)
            asset = await studio.owned_asset(account.user_id, asset_id)
            if project:
                await studio.project(account.user_id, project)
            dao = DirectoryDao(session)
            versions = await dao.derived_versions(account.user_id, asset.id)
            rows, total = await dao.page(
                dao.usage(account.user_id, asset, project, versions), page, size
            )
            origin = asset.definition.get("sourceJob")
            items = []
            for work, title, shots, music, scenes, effects in rows:
                uses = []
                scene_ids = {s["id"] for s in (scenes or []) if s.get("sceneAssetId") in versions}
                effect_uses = [
                    effect for effect in (effects or []) if effect["assetId"] in versions
                ]
                for index, shot in enumerate(shots, 1):
                    lines = shot.get("lines", [])
                    adopted = bool(
                        shot.get("videoAssetId") in versions
                        or any(line.get("audioAssetId") in versions for line in lines)
                        or any(effect.get("shotId") == shot["id"] for effect in effect_uses)
                        or origin
                        and (
                            origin == shot.get("candidate")
                            or any(origin == line.get("audio") for line in lines)
                        )
                    )
                    if (
                        adopted
                        or shot.get("sceneAssetId") in versions
                        or (not shot.get("sceneAssetId") and shot.get("sceneId") in scene_ids)
                        or set(versions).intersection(shot.get("references", []))
                        or any(line.get("role") in versions for line in lines)
                    ):
                        uses.append({"id": shot["id"], "number": index, "adopted": adopted})
                items.append(
                    {
                        "project": work,
                        "title": title,
                        "music": music in versions,
                        "shots": uses,
                        "scenes": [
                            {"id": s["id"], "title": s["title"]}
                            for s in (scenes or [])
                            if s["id"] in scene_ids
                        ],
                        "soundEffects": [
                            {"id": effect["id"], "shotId": effect.get("shotId")}
                            for effect in effect_uses
                        ],
                    }
                )
            return {"items": items, "total": total}

    async def job_page(
        self, account: Account, page: int, size: int, state: str, kind: str, search: str
    ) -> dict:
        """跨作品查看本人任务，回到项目后再操作其候选和时间线。"""
        account.require("products.entertainment")
        account.require("studio.projects.read")
        async with self.database.sessions() as session:
            dao = DirectoryDao(session)
            rows, total = await dao.page(
                dao.jobs(
                    account.user_id,
                    state,
                    kind,
                    search,
                    "studio.assets.read" in account.permissions,
                ),
                page,
                size,
            )
            return {"items": [dict(row._mapping) for row in rows], "total": total}

    async def open(self, account: Account, project_id: str) -> dict:
        from app.modules.studio.service.library_service import StudioLibraryService

        account.require("products.entertainment")
        account.require("studio.projects.read")
        async with self.database.sessions() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id)
            return {
                **project_view(project),
                "document": (await self.documents.read(session, project.id)).model_dump(),
                "history": await dao.history(project),
                "assets": await StudioLibraryService(self).views(
                    session, account, await dao.assets(account.user_id, project_id)
                ),
                "jobs": [job_view(j) for j in await dao.jobs(project)],
            }

    async def save(
        self, account: Account, project_id: str, change: SaveDocument, restore: int | None = None
    ) -> dict:
        from app.modules.studio.service.library_service import StudioLibraryService

        account.require("products.entertainment")
        account.require("studio.projects.write")
        async with self.database.sessions.begin() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            commands = FoundationDao(session)
            fingerprint = content_hash({"change": change.model_dump(), "restore": restore})
            if change.requestKey:
                prior = await commands.command(account.user_id, project_id, change.requestKey)
                if prior:
                    if prior.request_hash != fingerprint:
                        raise DomainError(409, "保存请求标识已用于其他内容")
                    return prior.result
            if project.lifecycle == "archived":
                raise DomainError(409, "请先恢复作品，再继续编辑")
            if project.revision != change.revision:
                raise DomainError(409, "工程已更新，请重新载入后合并修改")
            document = (
                Document.model_validate((await dao.snapshot(project, restore)).document)
                if restore
                else change.document
            )
            if restore:
                frozen = await commands.snapshot(project_id, restore)
                if frozen and "brief" in frozen.manifest:
                    apply_brief(
                        project,
                        ProjectBrief.model_validate(
                            {
                                key: value
                                for key, value in frozen.manifest["brief"].items()
                                if key in ProjectBrief.model_fields
                            }
                        ),
                    )
            validate_document(
                document, await dao.assets(account.user_id, project_id), await dao.jobs(project)
            )
            validate_media_trims(document, await AssetDao(session).media_metadata(document.assets))
            saved = await self.documents.persist(
                session,
                account,
                project,
                document,
                f"恢复版本 {restore}" if restore else change.label,
            )
            result = {
                "revision": project.revision,
                "document": saved.model_dump(),
                "assets": await StudioLibraryService(self).views(
                    session, account, await dao.assets(account.user_id, project_id)
                ),
            }
            if change.requestKey:
                commands.remember(
                    StudioCommand(
                        id=identifier(),
                        owner_id=account.user_id,
                        project_id=project_id,
                        operation_key=change.requestKey,
                        request_hash=fingerprint,
                        command_type="document.save",
                        result=result,
                    )
                )
            return result

    async def review(self, account: Account, project_id: str, review: Review) -> dict:
        """旧逐镜入口只把选择转换为字段集合，合并与冲突仍由同一用例处理。"""
        from app.modules.studio.entity.vo.preparation_vo import ReviewFields

        comparison = await self.proposals.compare(account, project_id, review.proposalId)
        if comparison["revision"] != review.revision:
            raise DomainError(409, "工程已更新，请重新审阅")
        current = await self.open(account, project_id)
        proposal = current["proposal"] or {}
        ids = {shot["id"] for shot in current["document"]["shots"]} | {
            shot["id"] for shot in proposal.get("shots", [])
        }
        chosen = set(review.selected)
        if chosen - ids:
            raise DomainError(422, "确认的镜头不存在")
        fields = [
            change["key"]
            for change in comparison["changes"]
            if (len(change["path"]) > 1 and change["path"][1] in chosen)
            or (change["path"] == ["order"] and chosen and ids <= chosen)
        ]
        return await self.proposals.review(
            account,
            project_id,
            review.proposalId,
            ReviewFields(revision=review.revision, requestKey=identifier(), selected=fields),
        )

    async def asset_file(self, account: Account, project_id: str | None, asset_id: str) -> str:
        account.require("products.entertainment")
        account.require("studio.assets.read")
        account.require("files.read")
        async with self.database.sessions() as session:
            if project_id:
                await StudioDao(session).project(account.user_id, project_id)
            asset = await session.get(StudioAsset, asset_id)
            if (
                not asset
                or asset.owner != account.user_id
                or asset.project not in (None, project_id)
                or not asset.definition.get("fileId")
            ):
                raise DomainError(404, "素材文件不存在")
            return str(asset.definition["fileId"])

    async def link_asset(self, account: Account, project_id: str, asset_id: str) -> dict:
        """加锁后在最新工程上追加个人素材版本，避免覆盖同时发生的剪辑或重复引用。"""
        account.require("products.entertainment")
        account.require("studio.projects.write")
        async with self.database.sessions.begin() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            if project.lifecycle == "archived":
                raise DomainError(409, "请先恢复作品，再继续编辑")
            asset = await session.get(StudioAsset, asset_id)
            if not asset or asset.owner != account.user_id or asset.project is not None:
                raise DomainError(404, "个人素材版本不存在")
            snapshot = (await dao.snapshot(project)).document
            linked_id = await self.asset_versions.project_version(
                session, account, project_id, asset
            )
            if linked_id not in snapshot["assets"]:
                if len(snapshot["assets"]) >= 1000:
                    raise DomainError(422, "作品素材数量已达上限")
                await self.documents.persist(
                    session,
                    account,
                    project,
                    Document.model_validate(
                        {**snapshot, "assets": [*snapshot["assets"], linked_id]}
                    ),
                    "引用个人素材",
                )
            return {"revision": project.revision}

    async def library(self, account: Account) -> list[dict]:
        account.require("products.entertainment")
        account.require("studio.assets.read")
        async with self.database.sessions() as session:
            return [asset_view(a) for a in await StudioDao(session).assets(account.user_id, None)]

    async def asset(self, account: Account, body: AssetInput, *, origin: str | None = None) -> dict:
        from app.modules.studio.service.library_service import StudioLibraryService

        return await StudioLibraryService(self).save_asset(account, body, origin=origin)
