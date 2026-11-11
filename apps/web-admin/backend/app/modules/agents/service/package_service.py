"""声明式示例资源包：场景内容由装配注入，核心只认识资源与资产契约。"""

import copy
import hashlib
import json
from collections.abc import Awaitable, Callable
from typing import cast

from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.modules.agents.dao.package_dao import PackageDao
from app.modules.agents.entity.vo.agent_vo import AssetInput
from app.modules.agents.service.asset_service import AssetService
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.service.resources import ResourceService


class ExamplePackageService:
    """幂等初始化，编辑/删除不回填；显式复制最新版本使用独立包标记。"""

    def __init__(
        self,
        database: Database,
        resources: ResourceService,
        assets: AssetService,
        package: dict[str, object],
        factory: Callable[[], Awaitable[dict[str, AssetInput]]],
    ) -> None:
        self.database, self.resources, self.assets = database, resources, assets
        self.package, self.factory = package, factory

    def _declaration(self, copy_latest: bool) -> dict[str, object]:
        package = copy.deepcopy(self.package)
        if copy_latest:
            digest = hashlib.sha256(
                json.dumps(package, ensure_ascii=False, sort_keys=True).encode()
            ).hexdigest()[:16]
            package["id"] = str(package["id"]) + "-copy-" + digest
        return package

    async def _current(self, account: Account, package: dict[str, object]) -> dict[str, object]:
        status = await self.resources.package_status(account, package)
        items = cast(list[dict[str, object]], status["resources"])
        asset_ids = set(cast(list[str], status["assetIds"]))
        return {
            "agents": [item for item in items if item["kind"] == "agent"],
            "knowledgeBases": [item for item in items if item["kind"] == "knowledge"],
            "assets": [item for item in await self.assets.list(account) if item["id"] in asset_ids],
        }

    async def initialize(self, account: Account, copy_latest: bool = False) -> dict[str, object]:
        """先生成有界资料，再原子发布配置；失败回收本次新资料，完成标记不早于发布。"""
        account.require("agents.manage")
        package = self._declaration(copy_latest)
        # 固定物理连接持有会话锁；AsyncSession.commit 后会归还连接，不能用来持锁。
        async with self.database.engine.connect() as session:
            dao = PackageDao(session)
            if not await dao.acquire(account.user_id):
                await session.rollback()
                raise DomainError(409, "示例正在准备，请稍后刷新")
            await session.commit()
            try:
                if (await self.resources.package_status(account, package))["initialized"]:
                    return await self._current(account, package)
                await self.resources.initialize(account)
                defaults: dict[str, str] = {}
                for kind in ("tool", "skill"):
                    for item in await self.resources.catalog(account, kind):
                        if isinstance(item.get("logicalId"), str):
                            defaults[str(item["logicalId"])] = str(item["id"])
                before = {str(item["id"]) for item in await self.assets.list(account)}
                generated = await self.factory()
                uploaded: dict[str, str] = {}
                try:
                    for key, body in generated.items():
                        asset = await self.assets.upload(account, body)
                        uploaded[key] = str(asset["id"])

                    def resolve(value: object, field: str = "") -> object:
                        if isinstance(value, dict):
                            return {key: resolve(child, key) for key, child in value.items()}
                        if isinstance(value, list):
                            return [resolve(child, field) for child in value]
                        if isinstance(value, str):
                            if field in {"assetIds", "templateAssetIds", "knowledgeAssetIds"}:
                                return uploaded.get(value, value)
                            if field in {"skillIds", "toolIds", "fixedSkillId"}:
                                return defaults.get(value, value)
                        return value

                    resolved = cast(dict[str, object], resolve(package))
                    for item in cast(list[dict[str, object]], resolved["resources"]):
                        item["packageAssetIds"] = list(uploaded.values())
                        if copy_latest:
                            item["name"] = str(item["name"]) + "（最新副本）"
                    await self.resources.import_package(account, resolved)
                except BaseException:
                    # 提交响应中断时先核对完成标记，不能删除已被成功发布配置引用的资料。
                    if not (await self.resources.package_status(account, package))["initialized"]:
                        for identifier in uploaded.values():
                            if identifier not in before:
                                await self.assets.remove(account, identifier)
                    raise
                return await self._current(account, package)
            finally:
                await dao.release(account.user_id)
                await session.commit()
