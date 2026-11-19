"""快速草稿、候选和进入专业分镜的用例，所有权及工程修订与现有作品共用。"""

from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.foundation_dao import FoundationDao
from app.modules.studio.dao.quick_dao import QuickDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash, stable_id
from app.modules.studio.entity.do.foundation_do import StudioCommand
from app.modules.studio.entity.do.models import StudioProject
from app.modules.studio.entity.vo.quick_vo import CollectQuick, PromoteQuick, QuickDraft, SaveQuick
from app.modules.studio.entity.vo.studio_vo import AssetInput, Document, Shot, identifier
from app.modules.studio.service.foundation_service import authorize
from app.modules.studio.service.library_service import StudioLibraryService
from app.modules.studio.service.quick_generation_service import QuickGenerationService
from app.modules.studio.service.studio_service import job_view, validate_document

if TYPE_CHECKING:
    from app.modules.studio.service.media_jobs import MediaJobs


class QuickService:
    def __init__(self, media: "MediaJobs") -> None:
        self.media = media
        self.generation = QuickGenerationService(media)

    @staticmethod
    def editable(project: StudioProject, revision: int) -> None:
        if project.creation_mode != "quick":
            raise DomainError(409, "该作品已进入分镜创作，请从作品目录继续")
        if project.lifecycle != "active":
            raise DomainError(409, "请先恢复已归档作品")
        if project.revision != revision:
            raise DomainError(409, "草稿已在其他页面更新，请重新载入后合并")

    async def state(self, account: Account, project_id: str) -> dict:
        """任务轮询只读取已保存草稿；前端编辑草稿不应被后台刷新覆盖。"""
        authorize(account, "projects.read")
        async with self.media.database.sessions() as session:
            project = await StudioDao(session).project(account.user_id, project_id)
            draft = QuickDraft.model_validate(project.quick_draft)
            dao = QuickDao(session)
            jobs = await dao.candidates(project_id)
            references = list(
                dict.fromkeys(
                    [
                        *draft.references,
                        *(
                            identity
                            for job in jobs
                            for identity in (job.payload.get("quickDraft") or {}).get(
                                "references", []
                            )
                        ),
                    ]
                )
            )
            rows = await dao.references(account.user_id, project_id, references)
            if "studio.assets.read" not in account.permissions:
                rows = []
            result = {
                "id": project.id,
                "title": project.title,
                "revision": project.revision,
                "creationMode": project.creation_mode,
                "lifecycle": project.lifecycle,
                "draft": draft.model_dump(),
                "assets": await StudioLibraryService(self.media.studio).views(
                    session, account, rows
                ),
                "jobs": [
                    {
                        **job_view(job),
                        "quickDraft": job.payload.get("quickDraft"),
                        "candidateNumber": job.payload.get("quickSequence"),
                    }
                    for job in jobs
                ],
            }
        result["capabilities"] = await self.generation.capabilities(account)
        return result

    async def save(self, account: Account, project_id: str, body: SaveQuick) -> dict:
        """同一次事务保存规格、输入及正文镜像，复用公共 AI 选段修改与撤回。"""
        authorize(account, "projects.write")
        fingerprint = content_hash({"operation": "quick.save", **body.model_dump()})
        async with self.media.database.sessions.begin() as session:
            project = await StudioDao(session).project(account.user_id, project_id, lock=True)
            commands = FoundationDao(session)
            prior = await commands.command(account.user_id, project_id, body.requestKey)
            if prior:
                if prior.request_hash != fingerprint:
                    raise DomainError(409, "保存请求已用于其他草稿")
                return prior.result
            self.editable(project, body.revision)
            assets = await QuickDao(session).references(
                account.user_id, project_id, body.draft.references
            )
            if len(assets) != len(body.draft.references):
                raise DomainError(422, "参考素材不可读取，请重新选择")
            if assets:
                account.require("studio.assets.read")
            project.title = body.title
            project.quick_draft = body.draft.model_dump()
            project.aspect_width, project.aspect_height = (
                int(part) for part in body.draft.aspect.split(":")
            )
            project.target_duration_ms = body.draft.durationSeconds * 1000
            document = await self.media.studio.documents.read(session, project_id)
            document.script = body.draft.prompt
            await self.media.studio.documents.persist(
                session, account, project, document, "保存快速创作草稿"
            )
            result = {
                "id": project.id,
                "title": project.title,
                "revision": project.revision,
                "creationMode": project.creation_mode,
                "draft": project.quick_draft,
            }
            commands.remember(
                StudioCommand(
                    id=identifier(),
                    owner_id=account.user_id,
                    project_id=project_id,
                    operation_key=body.requestKey,
                    request_hash=fingerprint,
                    command_type="quick.save",
                    result=result,
                )
            )
        return result

    async def promote(self, account: Account, project_id: str, body: PromoteQuick) -> dict:
        """用明确选择的候选建立一镜工程；同一作品 ID 保留所有生成历史和来源。"""
        authorize(account, "projects.write")
        fingerprint = content_hash({"operation": "quick.promote", **body.model_dump()})
        async with self.media.database.sessions.begin() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            commands = FoundationDao(session)
            prior = await commands.command(account.user_id, project_id, body.requestKey)
            if prior:
                if prior.request_hash != fingerprint:
                    raise DomainError(409, "操作标识已用于其他升级内容")
                return prior.result
            self.editable(project, body.revision)
            job = await dao.locked_job(project, body.jobId)
            if (
                job.kind != "video"
                or job.state != "ready"
                or job.subject != "quick_" + project_id
                or not job.payload.get("quickDraft")
            ):
                raise DomainError(422, "请选择本作品已完成的快速视频候选")
            draft = QuickDraft.model_validate(job.payload["quickDraft"])
            current = await self.media.studio.documents.read(session, project_id)
            if current.shots:
                raise DomainError(409, "工程已有分镜，请重新载入，不能覆盖已有制作")
            document = Document(
                script=draft.prompt,
                assets=list(dict.fromkeys([*current.assets, *draft.references])),
                shots=[
                    Shot(
                        id=job.subject,
                        action=draft.prompt,
                        duration=int(job.payload["duration"]),
                        references=draft.references,
                        candidate=job.id,
                    )
                ],
            )
            validate_document(
                document, await dao.assets(account.user_id, project_id), await dao.jobs(project)
            )
            project.creation_mode = "storyboard"
            project.aspect_width, project.aspect_height = (
                int(part) for part in draft.aspect.split(":")
            )
            project.target_duration_ms = int(job.payload["duration"])
            await self.media.studio.documents.persist(
                session, account, project, document, "快速候选进入分镜创作"
            )
            result = {
                "id": project.id,
                "revision": project.revision,
                "creationMode": project.creation_mode,
            }
            commands.remember(
                StudioCommand(
                    id=identifier(),
                    owner_id=account.user_id,
                    project_id=project_id,
                    operation_key=body.requestKey,
                    request_hash=fingerprint,
                    command_type="quick.promote",
                    result=result,
                )
            )
            return result

    async def collect(self, account: Account, project_id: str, body: CollectQuick) -> dict:
        """固定候选收藏到个人库；不随随后编辑的草稿改变，重复收藏请求复用收据。"""
        authorize(account, "projects.read")
        authorize(account, "assets.write")
        async with self.media.database.sessions() as session:
            project = await StudioDao(session).project(account.user_id, project_id)
            job = await StudioDao(session).locked_job(project, body.jobId)
            if job.kind != "video" or job.subject != "quick_" + project_id:
                raise DomainError(404, "快速视频候选不存在")
        path, mime = await self.media.file(account, project_id, body.jobId)
        file = await self.media.studio.files.ingest_media(account, body.jobId, path, mime)
        return await self.media.studio.asset(
            account,
            AssetInput(
                kind="video",
                name=body.name,
                fileId=str(file["id"]),
                requestKey=stable_id("quick-collect", project_id + ":" + body.requestKey),
            ),
            origin=body.jobId,
        )
