"""素材版本用例；不可变版本通过只读兼容视图供现有导演和媒体工具读取。"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.files.service.file_service import FileService
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.asset_dao import AssetDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import stable_id
from app.modules.studio.entity.do.asset_do import (
    AssetFamily,
    AssetVersion,
    EntityVersion,
    EntityVersionAsset,
    StudioEntity,
)
from app.modules.studio.entity.do.models import StudioAsset
from app.modules.studio.entity.vo.studio_vo import AssetInput, identifier


class StudioAssetService:
    def __init__(self, files: FileService) -> None:
        self.files = files

    async def create(
        self,
        session: AsyncSession,
        account: Account,
        body: AssetInput,
        origin: str | None = None,
        *,
        version_id: str | None = None,
    ) -> str:
        """调用者先校验文件；同范围追加版本，跨范围引用创建独立实体。"""
        dao = AssetDao(session)
        if body.project:
            project = await StudioDao(session).project(account.user_id, body.project)
            if project.lifecycle == "archived":
                raise DomainError(409, "请先恢复作品，再继续编辑")
        parent = await dao.version(body.parent) if body.parent else None
        if body.parent and (
            not parent
            or parent.owner != account.user_id
            or (body.project and parent.project not in (None, body.project))
        ):
            raise DomainError(404, "素材来源不存在")
        if parent and parent.definition["kind"] != body.kind:
            raise DomainError(422, "新版本须与来源素材类型一致")
        family_id = (
            parent.family
            if parent and parent.project == body.project
            else (
                stable_id(body.project or account.user_id, parent.family)
                if parent
                else identifier()
            )
        )
        await dao.lock_family(family_id)
        record_id = version_id or identifier()
        if body.kind in {"character", "scene", "prop"}:
            family = await dao.entity(family_id, lock=True)
            if family is None:
                family = StudioEntity(
                    id=family_id,
                    owner_id=account.user_id,
                    project_id=body.project,
                    kind=body.kind,
                    name=body.name,
                    current_version_id=record_id,
                )
                dao.add(family)
                await session.flush()
            else:
                family.revision += 1
                family.name = body.name
                family.current_version_id = record_id
            source = await dao.entity_version(parent.id) if parent else None
            record = EntityVersion(
                id=record_id,
                entity_id=family_id,
                version_no=await dao.next_entity_version(family_id),
                origin_version_id=body.parent,
                name=body.name,
                description=body.description,
                voice_id=body.voice,
            )
            if source and source.voice_id == body.voice:
                record.voice_configuration_id, record.voice_configuration_revision = (
                    source.voice_configuration_id,
                    source.voice_configuration_revision,
                )
                record.voice_parameters = source.voice_parameters.copy()
                if parent and parent.project != body.project:
                    # 声音配置可复用，试听回执仍归原作品，不能生成越权的媒体链接。
                    record.voice_parameters.pop("previewJob", None)
            dao.add(record)
            await session.flush()
            # 旧角色图片转为普通媒体引用；版本关系不依赖一个特殊 fileId 字段。
            if parent and parent.definition.get("fileId") == body.fileId:
                for reference in await dao.references(parent.id):
                    dao.add(
                        EntityVersionAsset(
                            entity_version_id=record_id,
                            asset_version_id=reference.asset_version_id,
                            purpose=reference.purpose,
                            position=reference.position,
                        )
                    )
            elif body.fileId:
                media_id = identifier()
                media_family_id = identifier()
                dao.add(
                    AssetFamily(
                        id=media_family_id,
                        owner_id=account.user_id,
                        project_id=body.project,
                        kind="image",
                        name=body.name + "参考",
                        current_version_id=media_id,
                    )
                )
                await session.flush()
                dao.add(
                    AssetVersion(
                        id=media_id,
                        family_id=media_family_id,
                        version_no=1,
                        file_id=body.fileId,
                        name=body.name + "参考",
                        description="",
                        source_job_id=origin,
                    )
                )
                await session.flush()
                dao.add(
                    EntityVersionAsset(
                        entity_version_id=record_id,
                        asset_version_id=media_id,
                        purpose="reference",
                        position=0,
                    )
                )
                await self.files.bind_studio_asset(session, account, body.fileId, media_id)
        else:
            media_family = await dao.media_family(family_id)
            if media_family is None:
                media_family = AssetFamily(
                    id=family_id,
                    owner_id=account.user_id,
                    project_id=body.project,
                    kind=body.kind,
                    name=body.name,
                    current_version_id=record_id,
                )
                dao.add(media_family)
                await session.flush()
            else:
                media_family.name, media_family.current_version_id = body.name, record_id
            dao.add(
                AssetVersion(
                    id=record_id,
                    family_id=family_id,
                    version_no=await dao.next_media_version(family_id),
                    parent_version_id=body.parent,
                    file_id=body.fileId,
                    name=body.name,
                    description=body.description,
                    source_job_id=origin
                    or (parent.definition.get("sourceJob") if parent else None),
                )
            )
        await session.flush()
        if body.fileId:
            await self.files.bind_studio_asset(session, account, body.fileId, record_id)
        return record_id

    async def project_version(
        self, session: AsyncSession, account: Account, project: str, asset: StudioAsset
    ) -> str:
        """同一库版本在同一作品只引用一次；两部作品分别拥有自己的设定身份。"""
        if asset.project is not None or asset.definition["kind"] not in {
            "character",
            "scene",
            "prop",
        }:
            return asset.id
        target = stable_id(project, asset.id)
        if await AssetDao(session).version(target):
            return target
        return await self.create(
            session,
            account,
            AssetInput.model_validate(
                {
                    k: v
                    for k, v in {**asset.definition, "project": project, "parent": asset.id}.items()
                    if k in AssetInput.model_fields
                }
            ),
            version_id=target,
        )

    async def character_from_image(
        self,
        session: AsyncSession,
        account: Account,
        project: str,
        asset: StudioAsset,
        description: str = "",
    ) -> str:
        """用户将库中图片选作形象时创建作品角色，通过原媒体版本保留来源，不改个人原件。"""
        if (
            asset.owner != account.user_id
            or asset.project not in (None, project)
            or asset.definition["kind"] != "image"
            or not asset.definition.get("fileId")
        ):
            raise DomainError(404, "参考图片不存在或不可用于当前作品")
        dao = AssetDao(session)
        target = stable_id(project, "director-character:" + asset.id)
        await dao.lock_family(target)
        if await dao.version(target):
            return target
        result = await self.create(
            session,
            account,
            AssetInput(
                kind="character",
                name=asset.definition["name"],
                description=(description or asset.definition.get("description", ""))[:6000],
                project=project,
            ),
            version_id=target,
        )
        # 原图即角色的 reference 版本，来源关系由既有实体—素材关联表表达。
        dao.add(
            EntityVersionAsset(
                entity_version_id=result,
                asset_version_id=asset.id,
                purpose="reference",
                position=0,
            )
        )
        await session.flush()
        return result
