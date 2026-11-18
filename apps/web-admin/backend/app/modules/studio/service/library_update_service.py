"""库更新先比较再采用；保留本片剪辑与已生成候选，冲突必须明确确认。"""

from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.asset_dao import AssetDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.library_changes import (
    affected_references,
    replace_reference,
)
from app.modules.studio.entity.do.models import StudioAsset, StudioProject
from app.modules.studio.entity.vo.library_vo import ApplyLibraryUpdate, PreviewLibraryUpdate
from app.modules.studio.entity.vo.studio_vo import AssetInput, Document

if TYPE_CHECKING:
    from app.modules.studio.service.library_service import StudioLibraryService


class LibraryUpdateService:
    def __init__(self, library: "StudioLibraryService") -> None:
        self.library = library

    async def context(
        self, session: AsyncSession, account: Account, project: StudioProject, asset_id: str
    ) -> tuple[Document, StudioAsset, StudioAsset, StudioAsset]:
        document = await self.library.studio.documents.read(session, project.id)
        asset = await StudioDao(session).owned_asset(account.user_id, asset_id)
        if asset.project != project.id or asset.id not in document.assets:
            raise DomainError(404, "该素材不是当前作品采用的设定")
        if asset.definition["kind"] not in {"character", "scene", "prop"}:
            raise DomainError(422, "媒体文件请明确选用新版本，不能作为角色设定合并")
        base = await self.library.origin(session, account, asset)
        incoming = await self.library.incoming(session, account, base) if base else None
        if base is None or incoming is None:
            raise DomainError(409, "未找到可更新的库内来源，请先收藏当前设定")
        return document, asset, base, incoming

    async def preview(self, account: Account, project_id: str, body: PreviewLibraryUpdate) -> dict:
        self.library.authorize(account, project=True)
        async with self.library.studio.database.sessions() as session:
            project = await StudioDao(session).project(account.user_id, project_id)
            document, asset, base, incoming = await self.context(
                session, account, project, body.assetId
            )
            return {
                "projectRevision": project.revision,
                "assetId": asset.id,
                "sourceVersionId": incoming.id,
                "baseVersionId": base.id,
                "fields": await self.library.comparison(session, account, asset, base, incoming),
                "affected": affected_references(document, asset.id),
            }

    async def apply(self, account: Account, project_id: str, body: ApplyLibraryUpdate) -> dict:
        self.library.authorize(account, write=True, project=True)
        operation = {"operation": "update", "project": project_id, **body.model_dump()}
        async with self.library.studio.database.sessions.begin() as session:
            previous = await self.library.replay(session, account, body.requestKey, operation)
            if previous:
                return previous
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            self.library.editable(project, body.expectedRevision)
            document, source, base, incoming = await self.context(
                session, account, project, body.assetId
            )
            await AssetDao(session).lock_family(incoming.family)
            # 库更新与采用共用家族锁，不能在检查后悄悄换成另一版输入。
            latest = await self.library.incoming(session, account, base)
            if latest is None or latest.id != body.sourceVersionId or incoming.id != latest.id:
                raise DomainError(409, "库内设定已更新，请重新比较")
            changes = await self.library.comparison(session, account, source, base, incoming)
            if not body.overwriteConflicts and any(
                field["key"] in body.fields and field["conflict"] for field in changes
            ):
                raise DomainError(409, "所选字段在本片与库中均已修改，请确认冲突后采用")
            selected = {
                field["key"]
                for field in changes
                if field["key"] in body.fields and field["changed"]
            }
            if not selected:
                result = await self.library.result(session, account, project, document, source.id)
                self.library.remember(session, account, body.requestKey, operation, result)
                return result
            values = {
                key: value
                for key, value in source.definition.items()
                if key in AssetInput.model_fields
            }
            for key in selected & {"name", "description"}:
                values[key] = incoming.definition.get(key, "")
            if "appearance" in selected:
                values["fileId"] = incoming.definition.get("fileId")
            if "voice" in selected:
                values["voice"] = incoming.definition.get("voice", "")
            values.update(project=project_id, parent=source.id)
            new_id = await self.library.studio.asset_versions.create(
                session, account, AssetInput.model_validate(values)
            )
            if "voice" in selected:
                await self.copy_voice(session, new_id, incoming)
            new_asset = await dao.owned_asset(account.user_id, new_id)
            changed = replace_reference(document, source.id, new_id)
            saved = await self.library.studio.documents.persist(
                session, account, project, changed, "采用素材库更新"
            )
            await self.library.bind(
                session, account, new_asset, incoming, fields=selected, base_version=base
            )
            result = await self.library.result(session, account, project, saved, new_id)
            self.library.remember(session, account, body.requestKey, operation, result)
            return result

    async def copy_voice(self, session: AsyncSession, target_id: str, source: StudioAsset) -> None:
        dao = AssetDao(session)
        target = await dao.entity_version(target_id)
        original = await dao.entity_version(source.id)
        if target is None or original is None:
            raise DomainError(409, "角色声音版本不可用")
        target.voice_configuration_id = original.voice_configuration_id
        target.voice_configuration_revision = original.voice_configuration_revision
        target.voice_parameters = {
            key: value for key, value in original.voice_parameters.items() if key != "previewJob"
        }
        await dao.replace_references(target_id, "voice-preview", await dao.references(source.id))
        await session.flush()
