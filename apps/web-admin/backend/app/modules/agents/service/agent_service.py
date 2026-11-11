"""智能体管理用例：组合现有资源领域和资产服务，保持执行引擎边界。"""

from builtins import list as List
from typing import cast

from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.agents.entity.vo.agent_vo import AgentInput
from app.modules.agents.service.asset_service import AssetService
from app.modules.agents.service.package_service import ExamplePackageService
from app.modules.agents.service.readiness import check_readiness
from app.modules.files.service.file_service import FileService
from app.modules.identity.entity.bo.models import Account
from app.modules.models.service.model_service import Audit
from app.modules.resources.service.resources import ResourceService


class AgentService:
    """资源为配置，工作台才触发 DSH；管理页检查和试用不会自动发起执行。"""

    def __init__(
        self,
        database: Database,
        resources: ResourceService,
        files: FileService,
        audit: Audit | None = None,
    ) -> None:
        self.resources, self.audit = resources, audit
        self.assets = AssetService(database, files, resources)
        self.examples: ExamplePackageService | None = None

    async def list(
        self, account: Account, page: int, size: int, search: str, management: bool = False
    ) -> dict[str, object]:
        """管理列表限定本人，工作台只列出已发布且启用的智能体。"""
        if management:
            return await self.resources.list(account, "agent", page, size, search)
        items = [
            item
            for item in await self.resources.published_agents(account)
            if search.casefold() in str(item["name"]).casefold()
        ]
        return {
            "items": items[(page - 1) * size : page * size],
            "total": len(items),
            "page": page,
            "pageSize": size,
        }

    async def catalog(self, account: Account) -> dict[str, List[dict[str, object]]]:
        """组合配置选择器需要的完整目录，所有子服务保留自身授权。"""
        account.require("agents.manage")
        await self.resources.initialize(account)
        return {
            "assets": await self.assets.list(account),
            "knowledgeBases": await self.resources.catalog(account, "knowledge"),
            "skills": await self.resources.catalog(account, "skill"),
            "tools": await self.resources.catalog(account, "tool"),
        }

    async def _validate(
        self, account: Account, definition: dict[str, object]
    ) -> tuple[dict[str, List[dict[str, object]]], List[dict[str, object]]]:
        catalog = await self.catalog(account)
        identifiers = set(
            cast(List[str], definition.get("knowledgeAssetIds", []))
            + cast(List[str], definition.get("templateAssetIds", []))
        )
        for identifier in cast(List[str], definition.get("knowledgeBaseIds", [])):
            base = next(
                (
                    item
                    for item in catalog["knowledgeBases"]
                    if item["id"] == identifier and item.get("enabled")
                ),
                None,
            )
            if base is None:
                raise DomainError(422, "绑定的知识库不存在或已停用")
            identifiers.update(cast(List[str], base.get("assetIds", [])))
        for identifier in cast(List[str], definition.get("skillIds", [])):
            skill = next(
                (
                    item
                    for item in catalog["skills"]
                    if item["id"] == identifier and item.get("enabled")
                ),
                None,
            )
            if skill:
                identifiers.update(cast(List[str], skill.get("templateAssetIds", [])))
        selected = [
            await self.assets.get(account, identifier) for identifier in sorted(identifiers)
        ]
        knowledge_ids = cast(List[str], definition.get("knowledgeAssetIds", []))
        template_ids = cast(List[str], definition.get("templateAssetIds", []))
        if any(
            (item["id"] in knowledge_ids and item["kind"] != "knowledge")
            or (item["id"] in template_ids and item["kind"] == "knowledge")
            for item in selected
        ):
            raise DomainError(422, "资料与模板类型不匹配")
        return catalog, selected

    async def save(
        self, account: Account, body: AgentInput, identifier: str | None = None
    ) -> dict[str, object]:
        """编辑需要版本；发布前完成组合校验，不能以提示词绕过技能工具依赖。"""
        account.require("agents.manage")
        if identifier and body.version is None:
            raise DomainError(422, "更新智能体必须提供当前版本")
        definition = body.model_dump(exclude_none=True)
        catalog, assets = await self._validate(account, definition)
        readiness = check_readiness(definition, catalog, assets)
        if body.published and not readiness["ready"]:
            raise DomainError(422, "；".join(cast(List[str], readiness["errors"])))
        value = await self.resources.save(account, "agent", definition, identifier)
        if self.audit:
            await self.audit(
                account.user_id,
                "agent.update" if identifier else "agent.create",
                str(value["id"]),
                {"version": value["version"], "published": value["published"]},
            )
        return value

    async def readiness(self, account: Account, identifier: str) -> dict[str, object]:
        """返回可逐项展示的真实配置错误和改善建议。"""
        definition = await self.resources.get(account, "agent", identifier)
        catalog, assets = await self._validate(account, definition)
        return check_readiness(definition, catalog, assets)

    async def remove(self, account: Account, identifier: str) -> None:
        """软删除保留冻结历史并阻止新的发布选择。"""
        await self.resources.delete(account, "agent", identifier)
        if self.audit:
            await self.audit(account.user_id, "agent.delete", identifier, {})

    async def initialize(self, account: Account, copy_latest: bool = False) -> dict[str, object]:
        """默认声明仅首次导入，不覆盖用户已修改或删除的配置。"""
        account.require("agents.manage")
        if self.examples is None:
            raise DomainError(503, "示例资源包尚未装配")
        return await self.examples.initialize(account, copy_latest)

    async def resolve_binding(self, account: Account, agent_id: str) -> dict[str, object]:
        """工作台读取可见的发布组合；真正执行前由资源绑定再次验证并持久冻结。"""
        bundle = await self.resources.published_bundle(account, agent_id)
        assets = await self.assets.published_assets(account, agent_id)
        definition = cast(dict[str, object], bundle["definition"])
        bundle["definition"] = {
            **definition,
            "knowledgeAssetIds": [item["id"] for item in assets if item["kind"] == "knowledge"],
            "templateAssetIds": [item["id"] for item in assets if item["kind"] != "knowledge"],
        }
        bundle["assets"] = assets
        return bundle
