"""技能编辑、包导入、匹配与发布用例，不承担Agent调度。"""

import asyncio
import base64
from pathlib import PurePosixPath

from pydantic import ValidationError

from app.infrastructure.errors import DomainError
from app.modules.agents.entity.vo.agent_vo import AssetInput
from app.modules.agents.service.asset_service import AssetService
from app.modules.extensions.service.extension_service import ExtensionService
from app.modules.extensions.service.validation import decode_archive, object_schema, package_path
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.service.resources import ResourceService
from app.modules.skills.entity.vo.management import (
    ExtensionSkillInput,
    SkillImportInput,
    SkillInput,
    SkillMatchInput,
)
from app.modules.skills.service.archive import read_skill
from app.modules.skills.service.matching import match_skills


class SkillManagementService:
    """草稿与发布定义分开保存，当前会话继续使用冻结程序版本。"""

    def __init__(
        self, resources: ResourceService, assets: AssetService, extensions: ExtensionService
    ) -> None:
        self.resources, self.assets, self.extensions = resources, assets, extensions

    async def save(
        self, account: Account, body: SkillInput, identifier: str | None = None
    ) -> dict[str, object]:
        """校验工具授权、资料哈希及阶段引用；未提交字段保留原资源值。"""
        account.require("agents.manage")
        previous = await self.resources.get(account, "skill", identifier) if identifier else {}
        payload = {**previous, **body.model_dump(exclude_unset=True, mode="json")}
        for key in ("id", "createdAt", "updatedAt"):
            payload.pop(key, None)
        required = payload.get("requiredToolIds", [])
        if not isinstance(required, list) or len(set(map(str, required))) != len(required):
            raise DomainError(422, "技能工具引用无效或重复")
        tools = {str(tool["id"]): tool for tool in await self.resources.catalog(account, "tool")}
        if any(
            str(identifier) not in tools or not tools[str(identifier)]["enabled"]
            for identifier in required
        ):
            raise DomainError(422, "技能所需工具不存在或已停用")
        skills = {
            str(skill["id"]): skill for skill in await self.resources.catalog(account, "skill")
        }
        for field in ("program", "programDraft"):
            program = payload.get(field)
            if not isinstance(program, dict):
                continue
            stages = program.get("stages", [])
            assert isinstance(stages, list)
            for stage in stages:
                assert isinstance(stage, dict)
                object_schema(stage.get("outputSchema", {"type": "object"}))
                granted = [*stage.get("toolIds", []), *stage.get("inspectToolIds", [])]
                if any(tool not in required for tool in granted):
                    raise DomainError(422, "阶段工具必须包含在技能所需工具中")
                referenced = stage.get("skillId")
                if referenced:
                    target = skills.get(str(referenced))
                    if referenced == identifier or target is None or not target.get("enabled"):
                        raise DomainError(422, "阶段引用技能不存在、已停用或形成循环")
                    self._check_cycle(skills, str(referenced), identifier, set())
                    required_tools = target.get("requiredToolIds", [])
                    if not isinstance(required_tools, list):
                        raise DomainError(422, "引用技能授权工具格式无效")
                    if any(
                        tool not in required for tool in required_tools if isinstance(tool, str)
                    ):
                        raise DomainError(422, "引用技能的工具未列入当前技能授权")
        references = payload.get("references", []) or []
        assert isinstance(references, list)
        seen: set[str] = set()
        for reference in references:
            assert isinstance(reference, dict)
            path = package_path(str(reference["path"]))
            if path.casefold() in seen:
                raise DomainError(422, "技能资料路径重复")
            seen.add(path.casefold())
            asset = await self.assets.get(account, str(reference["assetId"]))
            if asset["sha256"] != reference["sha256"]:
                raise DomainError(409, "技能资料内容已改变，请重新导入")
        return await self.resources.save(account, "skill", payload, identifier)

    def _check_cycle(
        self, skills: dict[str, dict[str, object]], current: str, target: str | None, path: set[str]
    ) -> None:
        if current == target or current in path or len(path) > 20:
            raise DomainError(422, "技能阶段引用形成循环或层级过深")
        skill = skills.get(current)
        if not skill:
            raise DomainError(422, "引用的技能不存在")
        for field in ("program", "programDraft"):
            program = skill.get(field)
            if isinstance(program, dict) and isinstance(program.get("stages"), list):
                for stage in program["stages"]:
                    if isinstance(stage, dict) and stage.get("skillId"):
                        self._check_cycle(skills, str(stage["skillId"]), target, path | {current})

    async def publish(self, account: Account, identifier: str, version: int) -> dict[str, object]:
        """发布原子追加资源版本，不能直接替换已绑定的历史程序。"""
        current = await self.resources.get(account, "skill", identifier)
        draft = current.get("programDraft")
        if not isinstance(draft, dict):
            raise DomainError(409, "没有可发布的技能草稿")
        payload = {key: item for key, item in current.items() if key in SkillInput.model_fields}
        payload.update({"version": version, "program": draft, "programDraft": None})
        return await self.save(account, SkillInput.model_validate(payload), identifier)

    async def match(self, account: Account, body: SkillMatchInput) -> list[dict[str, object]]:
        """只做确定性匹配预览，不启动DSH或修改会话。"""
        skills = await self.resources.catalog(account, "skill")
        return match_skills(
            [skill for skill in skills if not body.skillIds or skill["id"] in body.skillIds],
            body.request,
            body.extensions,
        )

    async def import_package(
        self, account: Account, body: SkillImportInput, raw: bytes | None = None
    ) -> dict[str, object]:
        """失败补偿仅删除本次新增且未被引用的资产，不删除去重复用的旧资产。"""
        account.require("agents.manage")
        metadata, files = await asyncio.to_thread(
            read_skill,
            raw if raw is not None else decode_archive(body.contentBase64, 12 * 1024 * 1024),
        )
        if body.requiredToolIds is not None:
            metadata["requiredToolIds"] = body.requiredToolIds
        if body.version is not None:
            metadata["version"] = body.version
        metadata["enabled"] = True
        original_ids = {str(asset["id"]) for asset in await self.assets.list(account)}
        created: list[str] = []
        references: list[dict[str, object]] = []
        try:
            for path, data in files.items():
                suffix = PurePosixPath(path).suffix.lower()
                kind = (
                    {
                        ".docx": "document-template",
                        ".xlsx": "spreadsheet-template",
                        ".pptx": "presentation-template",
                    }.get(suffix, "knowledge")
                    if path.startswith("templates/")
                    else "knowledge"
                )
                asset = await self.assets.upload(
                    account,
                    AssetInput.model_validate(
                        {
                            "name": PurePosixPath(path).name,
                            "kind": kind,
                            "contentBase64": base64.b64encode(data).decode(),
                        }
                    ),
                )
                identifier = str(asset["id"])
                if identifier not in original_ids:
                    created.append(identifier)
                references.append({"path": path, "assetId": identifier, "sha256": asset["sha256"]})
            metadata["references"] = references
            try:
                validated = SkillInput.model_validate(metadata)
            except ValidationError as error:
                raise DomainError(422, "技能包定义或工具引用无效") from error
            return await self.save(account, validated, body.id)
        except BaseException:
            for identifier in reversed(created):
                try:
                    await asyncio.shield(self.assets.remove(account, identifier))
                except DomainError:
                    # 已经被并发配置引用的资产必须保留，不能因导入失败破坏其他操作。
                    pass
            raise

    async def import_extension(
        self, account: Account, body: ExtensionSkillInput
    ) -> dict[str, object]:
        """从安装版本导出数据包后走相同导入校验，不执行技能目录脚本。"""
        data = await self.extensions.skill_archive(
            account, body.sourceId, body.sourceVersion, body.skillId
        )
        return await self.import_package(
            account,
            SkillImportInput(
                contentBase64="internal",
                id=body.id,
                version=body.version,
                requiredToolIds=body.requiredToolIds,
            ),
            data,
        )
