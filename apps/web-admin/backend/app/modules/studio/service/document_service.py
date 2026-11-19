"""当前工程写入入口；兼容文档仅为协议投影，所有写方共享事务与规范化过程。"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.asset_dao import AssetDao
from app.modules.studio.dao.document_dao import DocumentDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.document_projection import project_rows, read_document
from app.modules.studio.entity.bo.foundation import content_hash, timebase
from app.modules.studio.entity.do.foundation_do import ProjectSnapshot
from app.modules.studio.entity.do.models import StudioProject
from app.modules.studio.entity.vo.studio_vo import Document
from app.modules.studio.service.asset_service import StudioAssetService
from app.modules.studio.service.series_access_service import assert_episode_editable


class ProjectDocumentService:
    def __init__(self, assets: StudioAssetService) -> None:
        self.assets = assets

    async def read(self, session: AsyncSession, project: str) -> Document:
        rows = await DocumentDao(session).read(project)
        if rows["timeline"] is None or rows["script"] is None:
            raise DomainError(409, "作品结构尚未迁移完成，请先完成数据库迁移")
        return read_document(rows)

    async def persist(
        self,
        session: AsyncSession,
        account: Account,
        project: StudioProject,
        document: Document,
        label: str,
    ) -> Document:
        """持有项目行锁后调用；当前行与只读历史在一次事务提交。"""
        await assert_episode_editable(session, account, project)
        document = document.model_copy(deep=True)
        dao = StudioDao(session)
        catalog = {row.id: row for row in await dao.assets(account.user_id, project.id)}
        mapping: dict[str, str] = {}
        for identifier in document.assets:
            if identifier not in catalog:
                raise DomainError(422, "工程素材不可访问")
            mapping[identifier] = await self.assets.project_version(
                session, account, project.id, catalog[identifier]
            )
        document.assets = list(dict.fromkeys(mapping.values()))
        for effect in document.soundEffects:
            effect.assetId = mapping[effect.assetId]
        for scene in document.scenes:
            if scene.sceneAssetId:
                scene.sceneAssetId = mapping[scene.sceneAssetId]
        for shot in document.shots:
            shot.references = list(dict.fromkeys(mapping[ref] for ref in shot.references))
            if shot.sceneAssetId:
                shot.sceneAssetId = mapping[shot.sceneAssetId]
            if shot.videoAssetId:
                shot.videoAssetId = mapping[shot.videoAssetId]
            for line in shot.lines:
                line.role = mapping[line.role]
                if line.audioAssetId:
                    line.audioAssetId = mapping[line.audioAssetId]
        catalog = {row.id: row for row in await dao.assets(account.user_id, project.id)}
        jobs = await dao.jobs(project)
        clock = timebase()
        current = await DocumentDao(session).read(project.id)
        if current["timeline"] is not None:
            t = current["timeline"]
            clock = (t.ticks_per_second, t.fps_num, t.fps_den, t.audio_sample_rate)
        rows = project_rows(
            project.id,
            document,
            {key: row.definition["kind"] for key, row in catalog.items()},
            clock[0],
            {
                **(await AssetDao(session).media_metadata(document.assets)),
                **{row.id: int(row.payload.get("duration") or 0) for row in jobs},
            },
        )
        await DocumentDao(session).write(
            project.id, document.script, rows, clock, document.adaptationMode, document.musicVolume
        )
        dao.append(project, document.model_dump(), label)
        manifest = {"document": document.model_dump(), "brief": brief_view(project), "clock": clock}
        session.add(
            ProjectSnapshot(
                project_id=project.id,
                project_revision=project.revision,
                manifest=manifest,
                manifest_hash=content_hash(manifest),
                label=label,
            )
        )
        await session.flush()
        return document


def brief_view(project: StudioProject) -> dict[str, object]:
    """规格投影不包含内部路径、供应商连接或凭据。"""
    return {
        "title": project.title,
        "brief": project.brief,
        "aspectWidth": project.aspect_width,
        "aspectHeight": project.aspect_height,
        "targetDurationMs": project.target_duration_ms,
        "language": project.language,
        "styleBrief": project.style_brief,
        "lifecycle": project.lifecycle,
        "creationMode": project.creation_mode,
    }
