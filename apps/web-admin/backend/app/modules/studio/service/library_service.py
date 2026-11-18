"""素材中心用例：明确收藏、固定版本引用和来源绑定，事务内不调用外部模型。"""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.asset_dao import AssetDao
from app.modules.studio.dao.directory_dao import DirectoryDao
from app.modules.studio.dao.library_dao import LibraryDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash, stable_id
from app.modules.studio.entity.bo.library_changes import compare_fields, field_values
from app.modules.studio.entity.do.asset_do import EntityVersionAsset
from app.modules.studio.entity.do.library_do import LibraryBinding, LibraryOperation
from app.modules.studio.entity.do.models import StudioAsset, StudioProject
from app.modules.studio.entity.vo.library_vo import ArchiveLibrary, CollectLibrary, ImportLibrary
from app.modules.studio.entity.vo.studio_vo import AssetInput, Document, identifier

if TYPE_CHECKING:
    from app.modules.studio.service.media_jobs import MediaJobs
    from app.modules.studio.service.studio_service import StudioService


class StudioLibraryService:
    def __init__(self, studio: "StudioService", media: "MediaJobs | None" = None) -> None:
        self.studio, self.media = studio, media

    @staticmethod
    def authorize(account: Account, *, write: bool = False, project: bool = False) -> None:
        account.require("products.entertainment")
        account.require("studio.assets.read")
        if write:
            account.require("studio.assets.write")
        if project:
            account.require("studio.projects.write" if write else "studio.projects.read")

    async def page(
        self,
        account: Account,
        page: int,
        size: int,
        scope: str,
        kind: str,
        search: str,
        category: str,
        kinds: list[str],
        archived: bool = False,
    ) -> dict:
        self.authorize(account, project=scope == "project")
        async with self.studio.database.sessions() as session:
            dao = LibraryDao(session)
            query = dao.directory(account.user_id, scope, kind, search, category, archived)
            if kinds:
                query = query.where(StudioAsset.definition["kind"].as_string().in_(kinds))
            rows, total = await DirectoryDao(session).page(query, page, size)
            views = await self.views(session, account, [row[0] for row in rows])
            return {
                "items": [
                    {
                        **view,
                        "workId": row[1] if scope == "project" else None,
                        "workTitle": row[2] if scope == "project" else None,
                    }
                    for view, row in zip(views, rows, strict=True)
                ],
                "total": total,
            }

    async def views(
        self, session: AsyncSession, account: Account, assets: list[StudioAsset]
    ) -> list[dict]:
        from app.modules.studio.service.studio_service import asset_view

        metadata = await LibraryDao(session).metadata(account.user_id, assets)
        referenced = {
            version
            for item in metadata.values()
            if item["origin"]
            for version in [
                item["origin"]["versionId"],
                item["origin"]["currentVersionId"],
                *item["origin"].get("fieldVersions", {}).values(),
            ]
        }
        versions = (
            await LibraryDao(session).versions_by_id(account.user_id, list(referenced))
            if referenced
            else {}
        )
        for asset in assets:
            origin = metadata.get(asset.id, {}).get("origin")
            if origin:
                # 同一造型的不同历史版本共用来源绑定，但更新提示必须按各自内容计算。
                origin = dict(origin)
                metadata[asset.id]["origin"] = origin
                base, incoming = (
                    versions.get(origin["versionId"]),
                    versions.get(origin["currentVersionId"]),
                )
                bases = origin.pop("fieldVersions", {})
                changes = (
                    compare_fields(
                        base.definition,
                        asset.definition,
                        incoming.definition,
                        {
                            key: versions[version].definition
                            for key, version in bases.items()
                            if version in versions
                        },
                    )
                    if base and incoming
                    else []
                )
                origin["hasUpdates"] = any(change["changed"] for change in changes)
        return [{**asset_view(asset), **metadata.get(asset.id, {})} for asset in assets]

    async def comparison(
        self,
        session: AsyncSession,
        account: Account,
        asset: StudioAsset,
        base: StudioAsset,
        incoming: StudioAsset,
    ) -> list[dict]:
        """字段基线独立推进，保留用户暂未采用的库内差异。"""
        version = await AssetDao(session).entity_version(asset.id)
        binding = await LibraryDao(session).binding(
            account.user_id,
            asset.project or "",
            asset.family,
            version.variant_id or "" if version else "",
        )
        keys = binding.field_versions if binding else {}
        versions = (
            await LibraryDao(session).versions_by_id(account.user_id, list(keys.values()))
            if keys
            else {}
        )
        return compare_fields(
            base.definition,
            asset.definition,
            incoming.definition,
            {key: versions[value].definition for key, value in keys.items() if value in versions},
        )

    async def save_asset(
        self, account: Account, body: AssetInput, *, origin: str | None = None
    ) -> dict:
        """编辑设定复用同一幂等收据；新界面核对所选造型版本，旧工具调用保持兼容。"""
        self.authorize(account, write=True, project=body.project is not None)
        if body.fileId:
            file = await self.studio.files.entry(account, body.fileId)
            expected = {"music": "audio", "audio": "audio", "video": "video"}.get(
                body.kind, "image"
            )
            if not str(file["mediaType"]).startswith(expected + "/"):
                raise DomainError(422, "素材类型与上传文件不一致")
        operation = {"operation": "save", "origin": origin, **body.model_dump()}
        async with self.studio.database.sessions.begin() as session:
            if body.requestKey:
                prior = await self.replay(session, account, body.requestKey, operation)
                if prior:
                    return prior
            if body.parent:
                source = await StudioDao(session).owned_asset(account.user_id, body.parent)
                await AssetDao(session).lock_family(source.family)
                current = await self.incoming(session, account, source)
                if body.expectedVersionId and (
                    current is None or current.id != body.expectedVersionId
                ):
                    raise DomainError(409, "该造型已更新，请重新载入后合并设定")
                if body.requestKey and not body.expectedVersionId:
                    raise DomainError(422, "保存已有设定时请同时提供当前版本")
            created = await self.studio.asset_versions.create(session, account, body, origin)
            result = (
                await self.views(
                    session,
                    account,
                    [await StudioDao(session).owned_asset(account.user_id, created)],
                )
            )[0]
            if body.requestKey:
                self.remember(session, account, body.requestKey, operation, result)
            return result

    async def detail(self, account: Account, asset_id: str) -> dict:
        self.authorize(account)
        async with self.studio.database.sessions() as session:
            asset = await StudioDao(session).owned_asset(account.user_id, asset_id)
            if asset.project:
                account.require("studio.projects.read")
                await StudioDao(session).project(account.user_id, asset.project)
            dao = LibraryDao(session)
            root = await dao.root(account.user_id, asset.family)
            view = (await self.views(session, account, [asset]))[0]
            origin = view["origin"]
            versions = await self.views(
                session, account, await dao.versions(account.user_id, asset.family)
            )
            return {
                "asset": {
                    **view,
                    "origin": origin,
                    "archived": bool(root and root.archived_at),
                    "currentVersionId": root.current_version_id if root else asset.id,
                },
                "versions": versions,
                "origin": origin,
                "archived": bool(root and root.archived_at),
                "currentVersionId": root.current_version_id if root else asset.id,
                "variants": [
                    {
                        "id": variant.id,
                        "name": variant.name,
                        "currentVersionId": variant.current_version_id,
                    }
                    for variant in await dao.variants(asset.family)
                ],
            }

    async def archive(self, account: Account, asset_id: str, body: ArchiveLibrary) -> dict:
        self.authorize(account, write=True)
        operation = {"operation": "archive", "asset": asset_id, **body.model_dump()}
        async with self.studio.database.sessions.begin() as session:
            previous = await self.replay(session, account, body.requestKey, operation)
            if previous:
                return previous
            asset = await StudioDao(session).owned_asset(account.user_id, asset_id)
            if asset.project is not None:
                raise DomainError(422, "这里只归档个人库条目，本片素材请在作品内管理")
            await AssetDao(session).lock_family(asset.family)
            root = await LibraryDao(session).root(account.user_id, asset.family)
            if root is None or root.current_version_id != body.expectedVersionId:
                raise DomainError(409, "库条目已更新，请重新载入后操作")
            root.archived_at = datetime.now(UTC) if body.archived else None
            result = {"assetId": root.current_version_id, "archived": body.archived}
            self.remember(session, account, body.requestKey, operation, result)
            return result

    async def origin(
        self, session: AsyncSession, account: Account, asset: StudioAsset
    ) -> StudioAsset | None:
        if asset.project is None:
            return None
        dao = LibraryDao(session)
        version = await AssetDao(session).entity_version(asset.id)
        binding = await dao.binding(
            account.user_id,
            asset.project,
            asset.family,
            version.variant_id or "" if version else "",
        )
        if binding:
            source = binding.imported_version_id or binding.published_version_id
            return await StudioDao(session).owned_asset(account.user_id, source) if source else None
        return await dao.personal_ancestor(account.user_id, asset)

    async def incoming(
        self, session: AsyncSession, account: Account, source: StudioAsset
    ) -> StudioAsset | None:
        """已有作品只提示同一造型的更新，不把库中新建的另一套衣服自动当成更新。"""
        current = await LibraryDao(session).current(account.user_id, source.family)
        if current is None:
            return None
        version = await AssetDao(session).entity_version(source.id)
        variant = (
            await AssetDao(session).variant(version.variant_id)
            if version and version.variant_id
            else None
        )
        return (
            await StudioDao(session).owned_asset(account.user_id, variant.current_version_id)
            if variant
            else current
        )

    async def replay(
        self, session: AsyncSession, account: Account, key: str, value: dict
    ) -> dict | None:
        await lock_transaction(session, "studio-library:" + account.user_id + ":" + key)
        record = await LibraryDao(session).operation(account.user_id, key)
        if record:
            if record.request_hash != content_hash(value):
                raise DomainError(409, "请求标识已用于其他素材操作")
            return record.result
        return None

    @staticmethod
    def remember(
        session: AsyncSession, account: Account, key: str, value: dict, result: dict
    ) -> None:
        LibraryDao(session).add(
            LibraryOperation(
                id=identifier(),
                owner_id=account.user_id,
                request_key=key,
                request_hash=content_hash(value),
                result=result,
            )
        )

    async def bind(
        self,
        session: AsyncSession,
        account: Account,
        asset: StudioAsset,
        library: StudioAsset,
        *,
        published: bool = False,
        fields: set[str] | None = None,
        base_version: StudioAsset | None = None,
    ) -> None:
        if not asset.project:
            return
        dao = LibraryDao(session)
        version = await AssetDao(session).entity_version(asset.id)
        variant = version.variant_id or "" if version else ""
        binding = await dao.binding(account.user_id, asset.project, asset.family, variant)
        keys = set(field_values(library.definition))
        if library.definition["kind"] != "character":
            keys.discard("voice")
        baseline = base_version.id if base_version is not None else library.id
        if binding is None:
            binding = LibraryBinding(
                project_id=asset.project,
                project_family_id=asset.family,
                project_variant_id=variant,
                owner_id=account.user_id,
                library_family_id=library.family,
                imported_version_id=baseline,
                published_version_id=library.id if published else None,
                project_version_id=asset.id,
                field_versions={key: baseline for key in keys},
                revision=1,
            )
            dao.add(binding)
        else:
            if binding.library_family_id != library.family:
                raise DomainError(409, "本片设定已经关联其他库条目，请重新核对来源")
            binding.project_version_id = asset.id
            if published:
                binding.published_version_id = library.id
            binding.revision += 1
        if fields is None:
            binding.field_versions = {key: library.id for key in keys}
            binding.imported_version_id = library.id
        else:
            retained = binding.imported_version_id or baseline
            binding.field_versions = {
                key: library.id if key in fields else binding.field_versions.get(key, retained)
                for key in keys
            }
            revisions = set(binding.field_versions.values())
            if len(revisions) == 1:
                binding.imported_version_id = str(next(iter(revisions)))

    async def collect(self, account: Account, body: CollectLibrary) -> dict:
        self.authorize(account, write=True)
        operation = {"operation": "collect", **body.model_dump()}
        async with self.studio.database.sessions() as session:
            previous = await LibraryDao(session).operation(account.user_id, body.requestKey)
            if previous:
                if previous.request_hash != content_hash(operation):
                    raise DomainError(409, "请求标识已用于其他素材操作")
                return previous.result
        voice_file = await self.prepare_voice_preview(account, body.sourceVersionId)
        async with self.studio.database.sessions.begin() as session:
            prior = await self.replay(session, account, body.requestKey, operation)
            if prior:
                return prior
            dao = LibraryDao(session)
            source = await StudioDao(session).owned_asset(account.user_id, body.sourceVersionId)
            if source.project:
                account.require("studio.projects.read")
                await StudioDao(session).project(account.user_id, source.project)
            origin = await self.origin(session, account, source)
            if body.mode == "new":
                # 稳定来源身份使双击甚至使用两个请求号都不会产生第二张同源角色卡。
                family = (
                    origin.family
                    if origin
                    else (
                        source.family
                        if source.project is None
                        else stable_id(account.user_id, "library:" + source.family)
                    )
                )
            else:
                if source.project and origin is None:
                    raise DomainError(409, "请先收藏到个人库，再保存新版本或造型")
                family = origin.family if origin else source.family
            await AssetDao(session).lock_family(family)
            current = await dao.current(account.user_id, family)
            if current and (origin or source.project is None):
                current = await self.incoming(session, account, origin or source)
            if current and body.mode == "new":
                if origin is None:
                    await self.bind(session, account, source, current)
                result = {
                    "asset": (await self.views(session, account, [current]))[0],
                    "created": False,
                }
                self.remember(session, account, body.requestKey, operation, result)
                return result
            if body.mode != "new" and (current is None or body.expectedVersionId != current.id):
                raise DomainError(409, "库内设定已更新，请重新查看后再保存")
            kind = source.definition["kind"]
            if body.mode == "variant" and kind not in {"character", "scene", "prop"}:
                raise DomainError(422, "只有角色、场景与道具支持独立造型或变体")
            variant = None
            if body.mode == "variant":
                if any(v.name == body.variantName for v in await dao.variants(family)):
                    raise DomainError(409, "同名造型已存在，请换一个名称")
                variant = identifier()
            elif current and kind in {"character", "scene", "prop"}:
                base_version = await AssetDao(session).entity_version((origin or current).id)
                variant = base_version.variant_id if base_version else None
            values = {
                key: value
                for key, value in source.definition.items()
                if key in AssetInput.model_fields
            }
            values.update(project=None, parent=source.id)
            created_id = await self.studio.asset_versions.create(
                session,
                account,
                AssetInput.model_validate(values),
                target_family=family,
                target_variant=variant,
                variant_name=body.variantName,
            )
            if voice_file and kind == "character":
                await self.attach_voice_preview(session, account, created_id, source, voice_file)
            created = await StudioDao(session).owned_asset(account.user_id, created_id)
            await self.bind(session, account, source, created, published=True)
            result = {"asset": (await self.views(session, account, [created]))[0], "created": True}
            self.remember(session, account, body.requestKey, operation, result)
            return result

    async def import_version(self, account: Account, project_id: str, body: ImportLibrary) -> dict:
        self.authorize(account, write=True, project=True)
        operation = {"operation": "import", "project": project_id, **body.model_dump()}
        async with self.studio.database.sessions.begin() as session:
            prior = await self.replay(session, account, body.requestKey, operation)
            if prior:
                return prior
            studio = StudioDao(session)
            project = await studio.project(account.user_id, project_id, lock=True)
            self.editable(project, body.expectedRevision)
            source = await studio.owned_asset(account.user_id, body.sourceVersionId)
            if source.project is not None:
                raise DomainError(422, "请先将其他作品中的素材收藏到个人库")
            current = await LibraryDao(session).current(account.user_id, source.family)
            if current is None:
                raise DomainError(404, "库内素材已归档或不存在")
            document = await self.studio.documents.read(session, project_id)
            linked_id = await self.studio.asset_versions.project_version(
                session, account, project_id, source
            )
            linked = await studio.owned_asset(account.user_id, linked_id)
            if linked_id not in document.assets:
                await self.bind(session, account, linked, source)
                document.assets.append(linked_id)
                document = Document.model_validate(document.model_dump())
                document = await self.studio.documents.persist(
                    session, account, project, document, "从素材库引用"
                )
            result = await self.result(session, account, project, document, linked_id)
            self.remember(session, account, body.requestKey, operation, result)
            return result

    @staticmethod
    def editable(project: StudioProject, revision: int) -> None:
        if project.lifecycle == "archived":
            raise DomainError(409, "请先恢复作品，再修改素材引用")
        if project.revision != revision:
            raise DomainError(409, "工程已更新，请重新载入后核对素材")

    async def result(
        self,
        session: AsyncSession,
        account: Account,
        project: StudioProject,
        document: Document,
        asset_id: str,
    ) -> dict:
        return {
            "revision": project.revision,
            "document": document.model_dump(),
            "assetId": asset_id,
            "assets": await self.views(
                session, account, await StudioDao(session).assets(account.user_id, project.id)
            ),
        }

    async def prepare_voice_preview(self, account: Account, source_id: str) -> str | None:
        """将已完成试听保存为普通音频文件，复制设定不重新调用供应商或借用跨范围任务链接。"""
        if self.media is None:
            return None
        async with self.studio.database.sessions() as session:
            source = await StudioDao(session).owned_asset(account.user_id, source_id)
            if source.project:
                account.require("studio.projects.read")
            job = source.definition.get("voicePreviewJob")
            if source.definition["kind"] != "character" or not job:
                return None
            project = source.project
        path, mime = await self.media.file(account, project, str(job))
        return str((await self.studio.files.ingest_media(account, str(job), path, mime))["id"])

    async def attach_voice_preview(
        self,
        session: AsyncSession,
        account: Account,
        target: str,
        source: StudioAsset,
        file_id: str,
    ) -> None:
        dao = AssetDao(session)
        if any(ref.purpose == "voice-preview" for ref in await dao.references(target)):
            return
        preview_id = stable_id(account.user_id, "voice-preview:" + file_id)
        if await dao.version(preview_id) is None:
            await self.studio.asset_versions.create(
                session,
                account,
                AssetInput(
                    kind="audio", name=source.definition["name"] + "声音试听", fileId=file_id
                ),
                origin=source.definition.get("voicePreviewJob"),
                version_id=preview_id,
                target_family=stable_id(account.user_id, "voice-preview-family:" + file_id),
            )
        dao.add(
            EntityVersionAsset(
                entity_version_id=target,
                asset_version_id=preview_id,
                purpose="voice-preview",
                position=0,
            )
        )
        await session.flush()
