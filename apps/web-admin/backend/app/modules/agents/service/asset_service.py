"""资料和模板上传，跨域只通过文件公开服务复用存储。"""

import base64
import binascii
import hashlib
from builtins import list as List
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import PurePath
from uuid import uuid4

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.agents.dao.agent_dao import AgentDao
from app.modules.agents.entity.do.agent_do import AgentAssetRow
from app.modules.agents.entity.vo.agent_vo import AssetInput
from app.modules.files.service.file_service import FileService
from app.modules.identity.entity.bo.models import Account
from app.modules.knowledge.service.document_parser import parse_document_async
from app.modules.resources.service.resources import ResourceService


def asset_view(row: AgentAssetRow, include_segments: bool = False) -> dict[str, object]:
    """默认只返回有限预览，完整解析结果只由检索用例请求。"""
    result: dict[str, object] = {
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "size": row.size,
        "mediaType": row.media_type,
        "sha256": row.sha256,
        "preview": row.extracted_text[:1200],
        "createdAt": row.created_at.isoformat(),
    }
    if include_segments:
        result["segments"] = row.segments
    return result


def referenced_assets(resource: dict[str, object]) -> set[str]:
    """统一解析直接资料字段与技能包文件引用，不遗漏间接模板权限。"""
    identifiers: set[str] = set()
    for field in ("assetIds", "knowledgeAssetIds", "templateAssetIds"):
        values = resource.get(field, [])
        if isinstance(values, list):
            identifiers.update(str(item) for item in values)
    references = resource.get("references", [])
    if isinstance(references, list):
        identifiers.update(
            str(item["assetId"])
            for item in references
            if isinstance(item, dict) and isinstance(item.get("assetId"), str)
        )
    return identifiers


class AssetService:
    """解析先完成，再提交资料身份；并发相同上传得到同一资产。"""

    def __init__(self, database: Database, files: FileService, resources: ResourceService) -> None:
        self.database, self.files, self.resources = database, files, resources

    async def list(self, account: Account) -> List[dict[str, object]]:
        """管理页只能选择自己的资料。"""
        account.require("agents.manage")
        async with self.database.sessions() as session:
            return [asset_view(row) for row in await AgentDao(session).assets(account.user_id)]

    async def get(
        self, account: Account, identifier: str, include_segments: bool = False
    ) -> dict[str, object]:
        """知识检索每次读取时复查资产账号与文件状态。"""
        account.require("agents.manage")
        async with self.database.sessions() as session:
            row = await AgentDao(session).asset(account.user_id, identifier)
            if row is None:
                raise DomainError(404, "资料不存在")
        await self.files.read_asset(account, row.file_id)
        return asset_view(row, include_segments)

    async def preview(
        self,
        account: Account,
        identifier: str,
        renderer: Callable[[Account, str, bytes], Awaitable[bytes]],
    ) -> dict[str, object]:
        """授权当前资产后交由可配置渲染能力生成 PDF，不以文字摘要冒充预览。"""
        content, asset = await self.content(account, identifier)
        rendered = await renderer(account, str(asset["name"]), content)
        # 外部渲染完成后重新授权，撤销的资产不能被迟到结果重新发布。
        await self.get(account, identifier)
        return {
            **asset,
            "name": PurePath(str(asset["name"])).stem + ".pdf",
            "mediaType": "application/pdf",
            "size": len(rendered),
            "sha256": hashlib.sha256(rendered).hexdigest(),
            "contentBase64": base64.b64encode(rendered).decode(),
        }

    async def content(self, account: Account, identifier: str) -> tuple[bytes, dict[str, object]]:
        """提供文件内容给预览和执行适配，浏览器不获取存储对象路径。"""
        account.require("agents.manage")
        async with self.database.sessions() as session:
            row = await AgentDao(session).asset(account.user_id, identifier)
            if row is None:
                raise DomainError(404, "资料不存在")
        data, _ = await self.files.read_asset(account, row.file_id)
        return data, asset_view(row)

    async def upload(self, account: Account, body: AssetInput) -> dict[str, object]:
        """只接受规范 Base64；资料解析失败和超时不产生可用资产记录。"""
        account.require("agents.manage")
        try:
            data = base64.b64decode(body.contentBase64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise DomainError(422, "文件内容格式无效") from error
        if not data or base64.b64encode(data).decode() != body.contentBase64:
            raise DomainError(422, "文件内容格式无效")
        if len(data) > 4 * 1024 * 1024:
            raise DomainError(413, "文件不能超过 4 MiB")
        required_suffix = {
            "spreadsheet-template": ".xlsx",
            "presentation-template": ".pptx",
            "document-template": ".docx",
        }.get(body.kind)
        if required_suffix and PurePath(body.name).suffix.lower() != required_suffix:
            raise DomainError(422, "请选择与文件匹配的模板类型")
        digest = hashlib.sha256(data).hexdigest()
        async with self.database.sessions() as session:
            existing = await AgentDao(session).matching(
                account.user_id, body.kind, body.name, digest
            )
            if existing and existing.deleted_at is None:
                return asset_view(existing)
        parsed = await parse_document_async(body.name, data, body.kind != "knowledge")
        # 文件已经持久化后才公开资产；同一次重试不会覆盖旧内容。
        entry = await self.files.ingest_asset(account, body.name, data, parsed.media_type)
        published_id: str | None = None
        duplicate = False
        try:
            async with self.database.sessions() as session, session.begin():
                await lock_transaction(session, "agent-assets:" + account.user_id)
                dao = AgentDao(session)
                existing = await dao.matching(account.user_id, body.kind, body.name, digest)
                duplicate = existing is not None and existing.deleted_at is None
                if duplicate and existing:
                    row = existing
                elif existing:
                    existing.file_id, existing.deleted_at = str(entry["id"]), None
                    row = existing
                else:
                    row = AgentAssetRow(
                        id="asset-" + uuid4().hex,
                        owner_id=account.user_id,
                        file_id=str(entry["id"]),
                        name=body.name,
                        kind=body.kind,
                        size=len(data),
                        media_type=parsed.media_type,
                        sha256=digest,
                        extracted_text=parsed.text,
                        segments=parsed.segments,
                        created_at=datetime.now(UTC),
                    )
                    dao.add(row)
                result = asset_view(row)
                if not duplicate:
                    # 引用先于资产事务公开；回滚时撤销引用，不留下未绑定文件。
                    published_id = row.id
                    await self.files.bind_asset(account, str(entry["id"]), "asset", row.id)
            if duplicate:
                await self.files.remove_asset(account, str(entry["id"]))
            return result
        except BaseException:
            if published_id:
                await self.files.unbind_asset(account, str(entry["id"]), "asset", published_id)
            await self.files.remove_asset(account, str(entry["id"]))
            raise

    async def documents_for_reindex(self, account: Account) -> List[tuple[str, dict[str, object]]]:
        """仅全局模型配置用例使用，确保切换前所有账号原资料生成新索引代际。"""
        account.require("models.manage")
        account.require("agents.manage")
        async with self.database.sessions() as session:
            return [
                (row.owner_id, asset_view(row, True)) for row in await AgentDao(session).documents()
            ]

    async def remove(self, account: Account, identifier: str) -> None:
        """删除补偿只作用于未被配置引用的资料；原文件交统一回收站管理。"""
        account.require("agents.manage")
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "web-admin:resource:" + account.user_id)
            await lock_transaction(session, "agent-assets:" + account.user_id)
            for kind in ("agent", "knowledge", "skill"):
                for resource in await self.resources.catalog(account, kind):
                    if identifier in referenced_assets(resource):
                        raise DomainError(409, "资料正在被配置引用，不能删除")
            row = await AgentDao(session).asset(account.user_id, identifier)
            if row is None:
                raise DomainError(404, "资料不存在")
            row.deleted_at = datetime.now(UTC)
            file_id = row.file_id
        await self.files.unbind_asset(account, file_id, "asset", identifier)
        await self.files.remove_asset(account, file_id)

    async def validate_references(
        self, account: Account, kind: str, payload: dict[str, object]
    ) -> None:
        """资源服务持有统一引用锁后调用，阻止删除与保存之间的校验竞态。"""
        if kind not in {"agent", "knowledge", "skill"}:
            return
        for identifier in referenced_assets(payload):
            asset = await self.get(account, identifier)
            if kind == "knowledge" and asset["kind"] != "knowledge":
                raise DomainError(422, "知识库只能引用知识资料")

    async def execution_assets(
        self, account: Account, binding_id: str, include_segments: bool = False
    ) -> List[dict[str, object]]:
        """绑定校验先于资产读取，允许使用已发布者资料但不授予管理权限。"""
        binding = await self.resources.authorize_binding(account, binding_id)
        allowed: dict[str, str] = {}
        for snapshot in binding.snapshots:
            owner = str(snapshot.get("resourceOwnerId", account.user_id))
            for identifier in referenced_assets(snapshot):
                allowed[identifier] = owner
        result: List[dict[str, object]] = []
        async with self.database.sessions() as session:
            dao = AgentDao(session)
            for identifier, owner in allowed.items():
                row = await dao.asset(owner, identifier)
                if row is None:
                    raise DomainError(403, "绑定的资料已不可用")
                await self.files.read_owned_asset(owner, row.file_id)
                result.append(asset_view(row, include_segments))
        return result

    async def published_assets(self, account: Account, agent_id: str) -> List[dict[str, object]]:
        """工作台展示发布链内的资料元数据，不允许任意指定发布者和资产集合。"""
        bundle = await self.resources.published_bundle(account, agent_id)
        owner = str(bundle["resourceOwnerId"])
        resources = bundle.get("resources", [])
        allowed: set[str] = set()
        if isinstance(resources, list):
            for item in resources:
                if isinstance(item, dict):
                    allowed.update(referenced_assets(item))
        result: List[dict[str, object]] = []
        async with self.database.sessions() as session:
            for identifier in sorted(allowed):
                row = await AgentDao(session).asset(owner, identifier)
                if row is None:
                    raise DomainError(403, "已发布智能体的资料不可用")
                await self.files.read_owned_asset(owner, row.file_id)
                result.append(asset_view(row))
        return result

    async def execution_content(
        self, account: Account, binding_id: str, identifier: str
    ) -> tuple[bytes, dict[str, object]]:
        """下载必须在当前有效绑定的资产名单内，不能使用猜测的 owner 或文件 ID。"""
        allowed = await self.execution_assets(account, binding_id)
        asset = next((item for item in allowed if item["id"] == identifier), None)
        if asset is None:
            raise DomainError(403, "资料未绑定到当前会话")
        binding = await self.resources.authorize_binding(account, binding_id)
        owner = next(
            (
                str(item.get("resourceOwnerId", account.user_id))
                for item in binding.snapshots
                if identifier in referenced_assets(item)
            ),
            None,
        )
        if owner is None:
            raise DomainError(403, "绑定资料的所有者不可用")
        async with self.database.sessions() as session:
            row = await AgentDao(session).asset(owner, identifier)
            if row is None:
                raise DomainError(403, "资料已不可用")
        content, _ = await self.files.read_owned_asset(owner, row.file_id)
        return content, asset
