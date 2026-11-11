"""知识库管理、索引与来源核验，普通检索不能扩大当前资料授权范围。"""

from builtins import list as List
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.agents.service.agent_service import AgentService
from app.modules.identity.entity.bo.models import Account
from app.modules.knowledge.entity.vo.knowledge_vo import KnowledgeInput, RestoreInput
from app.modules.knowledge.service.index_service import KnowledgeIndexService
from app.modules.knowledge.service.profile_service import KnowledgeProfileService
from app.modules.knowledge.service.qdrant_service import QdrantService
from app.modules.knowledge.service.source_chunks import source_chunks
from app.modules.models.service.model_service import Audit
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.resources.service.resources import ResourceService


@dataclass(frozen=True)
class KnowledgeOptions:
    """部署侧配置不是浏览器 DTO；信任列表不能由网页修改。"""

    model_directory: Path
    qdrant_url: str
    qdrant_api_key: str = ""
    allowed_origins: str = ""
    trusted_origins: str = ""


class KnowledgeService:
    """知识库资源复用通用配置版本，解析资产与索引各有独立公开服务。"""

    def __init__(
        self,
        database: Database,
        resources: ResourceService,
        agents: AgentService,
        cipher: CredentialCipher,
        options: KnowledgeOptions,
        audit: Audit | None = None,
        account_lookup: Callable[[str], Awaitable[Account]] | None = None,
        qdrant: QdrantService | None = None,
        transport: ProviderTransport | None = None,
    ) -> None:
        self.resources, self.assets, self.audit, self.account_lookup = (
            resources,
            agents.assets,
            audit,
            account_lookup,
        )
        self.qdrant = qdrant or QdrantService(options.qdrant_url, options.qdrant_api_key)
        self.indexes = KnowledgeIndexService(database, self.qdrant)
        self.profiles = KnowledgeProfileService(
            database,
            cipher,
            self.assets,
            self.indexes,
            options.model_directory,
            transport or ProviderTransport(options.allowed_origins),
            options.trusted_origins,
            audit,
            account_lookup,
        )

    async def initialize(self) -> None:
        """启动清理中断任务状态，不静默下载模型或重发外部计费请求。"""
        await self.indexes.initialize()

    async def list(self, account: Account, page: int, size: int, search: str) -> dict[str, object]:
        """按账户与名称搜索知识库。"""
        return await self.resources.list(account, "knowledge", page, size, search)

    async def save(
        self, account: Account, body: KnowledgeInput, identifier: str | None = None
    ) -> dict[str, object]:
        """只允许绑定本人的知识资料，修改需要当前版本。"""
        account.require("agents.manage")
        if identifier and body.version is None:
            raise DomainError(422, "更新知识库必须提供当前版本")
        for asset_id in body.assetIds:
            asset = await self.assets.get(account, asset_id)
            if asset["kind"] != "knowledge":
                raise DomainError(422, "知识库只能绑定知识资料")
        result = await self.resources.save(
            account, "knowledge", body.model_dump(exclude_none=True), identifier
        )
        if self.audit:
            await self.audit(
                account.user_id,
                "knowledge.update" if identifier else "knowledge.create",
                str(result["id"]),
                {"version": result["version"]},
            )
        return result

    async def remove(self, account: Account, identifier: str) -> None:
        """软删除使当前知识授权立即失效，历史索引不再可查询。"""
        await self.resources.delete(account, "knowledge", identifier)
        if self.audit:
            await self.audit(account.user_id, "knowledge.delete", identifier, {})

    async def versions(
        self, account: Account, identifier: str, page: int = 1, size: int = 10
    ) -> dict[str, object]:
        """读取本人配置版本历史。"""
        result = await self.resources.versions(account, "knowledge", identifier)
        items = cast(List[dict[str, object]], result["items"])
        return {
            **result,
            "items": items[(page - 1) * size : page * size],
            "page": page,
            "pageSize": size,
        }

    async def restore(
        self, account: Account, identifier: str, body: RestoreInput
    ) -> dict[str, object]:
        """回退前复查资料仍存在且归属未变，不恢复已删除的资产。"""
        history = await self.resources.versions(account, "knowledge", identifier)
        items = cast(List[dict[str, object]], history["items"])
        selected = next((item for item in items if item.get("version") == body.sourceVersion), None)
        if selected is None:
            raise DomainError(404, "知识库历史版本不存在")
        snapshot = selected.get("snapshot", selected)
        if isinstance(snapshot, dict):
            for asset_id in cast(List[str], snapshot.get("assetIds", [])):
                await self.assets.get(account, asset_id)
        return await self.resources.restore(
            account, "knowledge", identifier, body.sourceVersion, body.version
        )

    async def _assets(
        self, account: Account, identifier: str, asset_id: str | None = None
    ) -> List[dict[str, object]]:
        base = await self.resources.get(account, "knowledge", identifier)
        if not base.get("enabled"):
            raise DomainError(403, "知识库已停用")
        identifiers = cast(List[str], base.get("assetIds", []))
        if asset_id is not None:
            if asset_id not in identifiers:
                raise DomainError(404, "资料不属于当前知识库")
            identifiers = [asset_id]
        return [await self.assets.get(account, value, True) for value in identifiers]

    async def status(self, account: Account) -> dict[str, object]:
        """独立报告检索依赖健康，不用管理页可打开冒充索引可用。"""
        account.require("agents.manage")
        try:
            await self.qdrant.request("/collections", method="GET")
            embedding = await self.profiles.current()
            await embedding.ready()
            from app.modules.knowledge.service.embedding_service import embedding_generation

            return {
                "engine": "qdrant",
                "ready": True,
                "generation": embedding_generation(embedding.profile),
                "embedding": embedding.profile,
                "message": "Qdrant 已连接 · 语义与关键词混合检索",
            }
        except DomainError as error:
            return {"engine": "qdrant", "ready": False, "message": error.detail}

    async def document_status(self, account: Account, identifier: str) -> dict[str, object]:
        """持久状态可在失败、刷新和重启后继续观察。"""
        assets = await self._assets(account, identifier)
        return {
            "items": await self.indexes.statuses(
                account.user_id, assets, await self.profiles.current()
            )
        }

    async def index(
        self, account: Account, identifier: str, asset_id: str | None = None
    ) -> dict[str, object]:
        """显式重建当前知识库，索引失败保留原始资料可重试。"""
        assets = await self._assets(account, identifier, asset_id)
        result = await self.indexes.index(
            account.user_id, assets, await self.profiles.current(), True
        )
        # 长操作结束重新授权，已撤销权限的请求不能领取结果。
        if self.account_lookup:
            account = await self.account_lookup(account.user_id)
        await self._assets(account, identifier, asset_id)
        if self.audit:
            await self.audit(account.user_id, "knowledge.index", identifier, result)
        return result

    async def search(self, account: Account, identifier: str, query: str) -> dict[str, object]:
        """只返回可回溯的当前授权原文，不回显索引服务提供的任意文本。"""
        assets = await self._assets(account, identifier)
        embedding = await self.profiles.current()
        await self.indexes.index(account.user_id, assets, embedding)
        sources = await self.qdrant.search(account.user_id, assets, query, embedding)
        if self.account_lookup:
            account = await self.account_lookup(account.user_id)
        current = await self._assets(account, identifier)
        allowed = {str(item["sourceId"]) for asset in current for item in source_chunks(asset)}
        return {"sources": [item for item in sources if item["sourceId"] in allowed]}

    async def search_binding(
        self, account: Account, binding_id: str, query: str
    ) -> List[dict[str, object]]:
        """DSH 知识工具入口使用当前有效冻结绑定，不接受模型传入任意资料集合。"""
        binding = await self.resources.authorize_binding(account, binding_id)
        assets = [
            item
            for item in await self.assets.execution_assets(account, binding_id, True)
            if item["kind"] == "knowledge"
        ]
        owner = next(
            (
                str(item.get("resourceOwnerId", account.user_id))
                for item in binding.snapshots
                if item.get("kind") == "agent"
            ),
            account.user_id,
        )
        embedding = await self.profiles.current()
        await self.indexes.index(owner, assets, embedding)
        sources = await self.qdrant.search(owner, assets, query[:200], embedding)
        await self.resources.authorize_binding(account, binding_id)
        return sources

    async def verify_source(
        self, account: Account, binding_id: str, source_id: str, quote: str | None = None
    ) -> dict[str, object]:
        """引用需逐字来自当前绑定资料，停用、删除或内容变更立即撤销证据。"""
        assets = await self.assets.execution_assets(account, binding_id, True)
        source = next(
            (
                item
                for asset in assets
                for item in source_chunks(asset)
                if item["sourceId"] == source_id
            ),
            None,
        )
        if source is None:
            raise DomainError(404, "原文证据不存在或当前会话无权访问")
        if quote is not None and (
            not quote.strip() or len(quote) > 900 or quote not in str(source["content"])
        ):
            raise DomainError(422, "引用摘录必须与授权原文逐字一致")
        return source
