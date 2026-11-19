"""第一阶段基础用例：作品规格、可靠保存和归档，与旧文档入口共享当前工程。"""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.foundation_dao import FoundationDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash, defaults
from app.modules.studio.entity.do.foundation_do import StudioCommand
from app.modules.studio.entity.do.models import StudioProject
from app.modules.studio.entity.vo.foundation_vo import (
    ArchiveProject,
    CreateProject,
    ProjectBrief,
    UpdateBrief,
)
from app.modules.studio.entity.vo.studio_vo import Document, identifier
from app.modules.studio.service.document_service import brief_view
from app.modules.studio.service.series_access_service import assert_episode_editable

if TYPE_CHECKING:
    from app.modules.studio.service.studio_service import StudioService


def authorize(account: Account, action: str) -> None:
    """产品资格和具体动作同时满足，角色名称不参与业务授权。"""
    account.require("products.entertainment")
    account.require("studio." + action)


def apply_brief(project: StudioProject, body: ProjectBrief) -> None:
    project.title, project.brief = body.title, body.brief
    project.aspect_width, project.aspect_height = body.aspectWidth, body.aspectHeight
    project.target_duration_ms, project.language = body.targetDurationMs, body.language
    project.style_brief = body.styleBrief


class StudioFoundationService:
    def __init__(self, studio: "StudioService") -> None:
        self.studio = studio

    def preferences(self, account: Account) -> dict[str, object]:
        authorize(account, "projects.read")
        return defaults()

    async def create(self, account: Account, body: CreateProject) -> dict:
        authorize(account, "projects.write")
        key = body.requestKey or identifier()
        creation = body.model_dump(exclude={"requestKey"})
        if body.creationMode == "storyboard":
            # 旧客户端不传模式；升级后仍识别以前的幂等创建回执。
            creation.pop("creationMode")
        fingerprint = content_hash(creation)
        async with self.studio.database.sessions.begin() as session:
            dao = FoundationDao(session)
            previous = await dao.creation(account.user_id, key)
            if previous:
                if previous.creation_hash != fingerprint:
                    raise DomainError(409, "同一创建请求已使用不同的作品内容")
                return {"id": previous.id, "revision": previous.revision, **brief_view(previous)}
            project = StudioProject(
                id=identifier(),
                owner=account.user_id,
                title=body.title,
                revision=0,
                creation_key=key,
                creation_hash=fingerprint,
                creation_mode=body.creationMode,
            )
            apply_brief(project, body)
            dao.add_project(project)
            await session.flush()
            await self.studio.documents.persist(session, account, project, Document(), "创建作品")
            return {"id": project.id, "revision": project.revision, **brief_view(project)}

    async def change(
        self, account: Account, project_id: str, body: UpdateBrief | ArchiveProject
    ) -> dict:
        authorize(account, "projects.write")
        fingerprint = content_hash(body.model_dump())
        async with self.studio.database.sessions.begin() as session:
            project = await StudioDao(session).project(account.user_id, project_id, lock=True)
            dao = FoundationDao(session)
            prior = await dao.command(account.user_id, project_id, body.requestKey)
            if prior:
                if prior.request_hash != fingerprint:
                    raise DomainError(409, "操作标识已用于其他修改")
                return prior.result
            if project.revision != body.revision:
                raise DomainError(409, "作品已在其他页面更新，请重新载入后合并")
            await assert_episode_editable(session, account, project)
            if isinstance(body, ArchiveProject):
                project.lifecycle = "archived" if body.archived else "active"
                project.archived_at = datetime.now(UTC) if body.archived else None
                label = "归档作品" if body.archived else "恢复作品"
            else:
                if project.lifecycle == "archived":
                    raise DomainError(409, "请先恢复作品，再继续编辑")
                apply_brief(project, body)
                label = "更新制作规格"
            document = await self.studio.documents.read(session, project_id)
            await self.studio.documents.persist(session, account, project, document, label)
            result = {"revision": project.revision, **brief_view(project)}
            dao.remember(
                StudioCommand(
                    id=identifier(),
                    owner_id=account.user_id,
                    project_id=project_id,
                    operation_key=body.requestKey,
                    request_hash=fingerprint,
                    command_type="project.change",
                    result=result,
                )
            )
            return result
