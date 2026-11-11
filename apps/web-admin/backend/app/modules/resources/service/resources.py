"""通用资源组合、版本冻结和配置授权，不包含 Office 名称分支。"""

import copy
import json
from builtins import list as List
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid4, uuid5

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.entity.bo.resources import Binding, Resource
from app.modules.resources.service.configuration import merge_settings, redact_settings
from app.modules.resources.service.ports import (
    ImplementationResolver,
    ResourceCipher,
    ResourceRepository,
    ResourceTransaction,
    SchemaValidator,
)


def public_resource(resource: Resource) -> dict[str, object]:
    """密文及 owner 内部字段不进入资源读取响应。"""
    return {
        **resource.payload,
        "id": resource.id,
        "name": resource.name,
        "description": resource.description,
        "enabled": resource.enabled,
        "published": resource.published,
        "version": resource.version,
        "createdAt": resource.created_at.isoformat() if resource.created_at else None,
        "updatedAt": resource.updated_at.isoformat() if resource.updated_at else None,
    }


class ResourceService:
    """资源编辑用权限码保护，执行时再次检查绑定中所有资源的当前状态。"""

    def __init__(
        self,
        repository: ResourceRepository,
        cipher: ResourceCipher,
        validator: SchemaValidator,
        default_package: dict[str, object] | None = None,
        schemas: dict[str, dict[str, object]] | None = None,
        implementations: ImplementationResolver | None = None,
    ) -> None:
        self.repository, self.cipher, self.validator = repository, cipher, validator
        self.default_package = default_package
        self.schemas = schemas or {}
        self.implementations = implementations
        self.asset_validator: (
            Callable[[Account, str, dict[str, object]], Awaitable[None]] | None
        ) = None
        self.tool_binding_resolver: (
            Callable[[Account, dict[str, object]], Awaitable[dict[str, object]]] | None
        ) = None

    async def initialize(self, account: Account) -> None:
        """资源包仅在账号首次初始化时导入，用户修改或删除后不自动恢复。"""
        package = self.default_package
        if package is None:
            return
        # 此入口只接受装配时注入的产品资源，注册普通账号也可初始化；
        # 外部导入仍必须经过 import_package 的管理权限检查。
        # 初始化是系统为账号分配固定产品配置，不是用户执行或管理能力；
        # 临时上下文仅在此私有导入中使用，不修改账号、角色或后续授权。
        bootstrap = replace(
            account, permissions=(*account.permissions, "agents.manage"), reset_required=False
        )
        await self._import_package(bootstrap, package)

    async def import_package(self, account: Account, package: dict[str, object]) -> dict[str, str]:
        """导入可信声明式资源包；两遍校验保证跨资源引用与所有默认配置原子提交。"""
        account.require("agents.manage")
        return await self._import_package(account, package)

    async def package_status(
        self, account: Account, package: dict[str, object]
    ) -> dict[str, object]:
        """读取声明包的初始化结果，包括已删除记录的原始资产引用，但不恢复资源。"""
        account.require("agents.manage")
        package_id = str(package["id"])
        definitions = package.get("resources", [])
        if not isinstance(definitions, list):
            raise RuntimeError("资源包声明无效")
        items: List[dict[str, object]] = []
        assets: set[str] = set()
        async with self.repository.transaction() as tx:
            initialized = await tx.initialized(account.user_id, package_id)
            for item in definitions:
                if not isinstance(item, dict):
                    raise RuntimeError("资源包条目无效")
                identifier = str(
                    uuid5(
                        NAMESPACE_URL, account.user_id + ":" + package_id + ":" + str(item["key"])
                    )
                )
                resource = await tx.get(identifier)
                if resource is None or resource.owner_id != account.user_id:
                    continue
                # 第一版冻结的来源用于显示初始化时的资料；后续编辑不改变包的归属。
                original = await tx.snapshot(resource.id, 1) or {}
                values = original.get("packageAssetIds", [])
                if isinstance(values, list):
                    assets.update(str(value) for value in values)
                if not resource.deleted:
                    items.append({**public_resource(resource), "kind": resource.kind})
        return {"initialized": initialized, "resources": items, "assetIds": sorted(assets)}

    async def _import_package(self, account: Account, package: dict[str, object]) -> dict[str, str]:
        package_id, definitions = package.get("id"), package.get("resources")
        if not isinstance(package_id, str) or not isinstance(definitions, list):
            raise RuntimeError("默认资源包结构无效")
        identifiers: dict[str, str] = {}
        for item in definitions:
            if (
                not isinstance(item, dict)
                or item.get("kind") not in {"agent", "skill", "tool", "knowledge"}
                or not isinstance(item.get("key"), str)
                or item["key"] in identifiers
            ):
                raise RuntimeError("默认资源包只能声明无重复标识的配置资源")
            identifiers[str(item["key"])] = str(
                uuid5(NAMESPACE_URL, account.user_id + ":" + package_id + ":" + str(item["key"]))
            )

        def replace_references(value: object, field: str = "") -> object:
            if isinstance(value, dict):
                return {key: replace_references(child, key) for key, child in value.items()}
            if isinstance(value, list):
                return [replace_references(child, field) for child in value]
            if isinstance(value, str) and field in {
                "toolIds",
                "requiredToolIds",
                "inspectToolIds",
                "skillIds",
                "skillId",
                "knowledgeBaseIds",
                "fixedSkillId",
            }:
                return identifiers.get(value, value)
            return value

        async with self.repository.transaction() as tx:
            await tx.lock(account.user_id)
            if await tx.initialized(account.user_id, package_id):
                return identifiers
            pending: List[Resource] = []
            for item in definitions:
                assert isinstance(item, dict)
                identifier = identifiers[str(item["key"])]
                resolved = replace_references(
                    {
                        key: copy.deepcopy(value)
                        for key, value in item.items()
                        if key not in {"key", "kind", "name", "description", "enabled", "published"}
                    }
                )
                assert isinstance(resolved, dict)
                payload = dict(resolved)
                now = datetime.now(UTC)
                resource = Resource(
                    identifier,
                    str(item["kind"]),
                    account.user_id,
                    str(item["name"]),
                    str(item.get("description", "")),
                    bool(item.get("enabled", True)),
                    bool(item.get("published", False)),
                    1,
                    payload,
                    None,
                    False,
                    now,
                    now,
                )
                if resource.kind == "tool":
                    await self._validate_references(tx, account, resource.kind, resource.payload)
                    settings = payload.get("settings", {})
                    schema = payload.get("configurationSchema", {"type": "object"})
                    assert isinstance(settings, dict) and isinstance(schema, dict)
                    self.validator.validate(settings, schema)
                    resource.secret_ciphertext = self.cipher.seal(json.dumps(settings), identifier)
                    resource.payload["settings"], resource.payload["configuredSecrets"] = (
                        redact_settings(settings, schema)
                    )
                await tx.save(resource, public_resource(resource))
                pending.append(resource)
            for resource in pending:
                await self._validate_references(
                    tx, account, resource.kind, resource.payload, resource.id
                )
            await tx.mark_initialized(account.user_id, package_id)
            return identifiers

    @staticmethod
    def require(account: Account, kind: str) -> None:
        """安装代码权限与编辑智能体配置权限分开。"""
        account.require("extensions.manage" if kind == "extension" else "agents.manage")

    async def _owned(
        self, tx: ResourceTransaction, account: Account, resource_id: str, kind: str | None = None
    ) -> Resource:
        resource = await tx.get(resource_id)
        if (
            resource is None
            or resource.deleted
            or resource.owner_id != account.user_id
            or (kind and resource.kind != kind)
        ):
            raise DomainError(404, "resource not found")
        return resource

    async def list(
        self, account: Account, kind: str, page: int, size: int, search: str
    ) -> dict[str, object]:
        """返回真实持久资源，不生成默认示例伪造列表。"""
        self.require(account, kind)
        async with self.repository.transaction() as tx:
            items = [
                resource
                for resource in await tx.all(kind, account.user_id)
                if search.lower() in (resource.name + " " + resource.description).lower()
            ]
            return {
                "items": [public_resource(item) for item in items[(page - 1) * size : page * size]],
                "total": len(items),
                "page": page,
                "pageSize": size,
            }

    async def get(self, account: Account, kind: str, resource_id: str) -> dict[str, object]:
        """跨模块读取使用公开合同，身份及凭据过滤不能由调用者绕过。"""
        self.require(account, kind)
        async with self.repository.transaction() as tx:
            return public_resource(await self._owned(tx, account, resource_id, kind))

    async def catalog(self, account: Account, kind: str) -> List[dict[str, object]]:
        """配置选择器读取本人资源全集，分页展示仍使用 list。"""
        self.require(account, kind)
        async with self.repository.transaction() as tx:
            return [public_resource(resource) for resource in await tx.all(kind, account.user_id)]

    async def published_agents(self, account: Account) -> List[dict[str, object]]:
        """工作台只读发布目录，不因查看目录取得编辑他人资源的权限。"""
        account.require("sessions.run")
        async with self.repository.transaction() as tx:
            return [public_resource(resource) for resource in await tx.published_agents()]

    async def _published_resources(
        self, tx: ResourceTransaction, account: Account, agent_id: str
    ) -> tuple[Resource, List[dict[str, object]]]:
        """发布只授权定义中可达的资源，不能借发布者身份扩大到任意资产。"""
        agent = await tx.get(agent_id)
        if agent is None or agent.deleted or agent.kind != "agent":
            raise DomainError(404, "agent not found")
        if not agent.published or not agent.enabled:
            raise DomainError(409, "agent is not published")
        pending: List[tuple[str, int | None]] = [(agent.id, None)]
        snapshots: dict[str, dict[str, object]] = {}
        while pending:
            identifier, expected_version = pending.pop()
            resource = await tx.get(identifier)
            if resource is None or resource.deleted or resource.owner_id != agent.owner_id:
                raise DomainError(409, "published resource reference is unavailable")
            if not resource.enabled:
                raise DomainError(403, "bound resource is disabled")
            key = resource.id + ":" + str(expected_version or resource.version)
            if key in snapshots:
                continue
            snapshot = (
                await tx.snapshot(resource.id, expected_version)
                if expected_version
                else public_resource(resource)
            )
            if snapshot is None:
                raise DomainError(409, "pinned resource version is unavailable")
            snapshots[key] = {
                **snapshot,
                "kind": resource.kind,
                "resourceOwnerId": resource.owner_id,
            }
            for field in ("toolIds", "requiredToolIds", "skillIds", "knowledgeBaseIds"):
                values = snapshot.get(field, [])
                if isinstance(values, list):
                    pending.extend((str(value), None) for value in values)
            program = snapshot.get("program")
            if isinstance(program, dict) and isinstance(program.get("stages"), list):
                pending.extend(
                    (str(stage["skillId"]), None)
                    for stage in program["stages"]
                    if isinstance(stage, dict) and stage.get("skillId")
                )
            implementation = snapshot.get("implementation")
            if isinstance(implementation, dict):
                if self.implementations is not None and "sourceVersion" not in implementation:
                    await self.implementations.bind(account, implementation)
                else:
                    pending.append(
                        (str(implementation["sourceId"]), int(implementation["sourceVersion"]))
                    )
        return agent, list(snapshots.values())

    async def published_bundle(self, account: Account, agent_id: str) -> dict[str, object]:
        """仅内部绑定服务使用，返回已验证的发布资源链及真实资源所有者。"""
        account.require("sessions.run")
        async with self.repository.transaction() as tx:
            agent, snapshots = await self._published_resources(tx, account, agent_id)
            return {
                "definition": public_resource(agent),
                "resourceOwnerId": agent.owner_id,
                "knowledgeBases": [item for item in snapshots if item["kind"] == "knowledge"],
                "skills": [item for item in snapshots if item["kind"] == "skill"],
                "tools": [item for item in snapshots if item["kind"] == "tool"],
                "resources": snapshots,
            }

    async def restore(
        self, account: Account, kind: str, resource_id: str, version: int, current_version: int
    ) -> dict[str, object]:
        """回退追加新版本，保留不可变历史和当时的密文；并发编辑返回冲突。"""
        self.require(account, kind)
        async with self.repository.transaction() as tx:
            await tx.lock(account.user_id)
            resource = await self._owned(tx, account, resource_id, kind)
            if resource.version != current_version:
                raise DomainError(409, "resource version conflict", "revision_conflict")
            snapshot = await tx.snapshot(resource_id, version)
            if snapshot is None:
                raise DomainError(404, "resource version not found")
            payload = {
                key: copy.deepcopy(value)
                for key, value in snapshot.items()
                if key
                not in {
                    "id",
                    "name",
                    "description",
                    "enabled",
                    "published",
                    "version",
                    "createdAt",
                    "updatedAt",
                }
            }
            await self._validate_references(tx, account, kind, payload, resource_id)
            resource.name = str(snapshot["name"])
            resource.description = str(snapshot.get("description", ""))
            resource.enabled = bool(snapshot.get("enabled", True))
            resource.published = bool(snapshot.get("published", False))
            resource.payload = payload
            resource.secret_ciphertext = await tx.secret(resource_id, version)
            resource.version += 1
            resource.updated_at = datetime.now(UTC)
            result = public_resource(resource)
            await tx.save(resource, result)
            return result

    async def _validate_references(
        self,
        tx: ResourceTransaction,
        account: Account,
        kind: str,
        payload: dict[str, object],
        resource_id: str | None = None,
    ) -> None:
        if kind == "skill":
            from app.modules.skills.service.graph_validation import validate_skill_graph

            # 与保存/回退共用所有者事务锁，阻止并发编辑各自通过检查后组成引用环。
            existing = {
                item.id: public_resource(item) for item in await tx.all("skill", account.user_id)
            }
            validate_skill_graph(
                payload, resource_id or str(payload.get("id", "__candidate__")), existing
            )
        if self.asset_validator:
            # 与资产删除共享owner资源锁，消除提交前校验后的删除窗口。
            await self.asset_validator(account, kind, payload)
        if (
            kind == "skill"
            and isinstance(payload.get("program"), dict)
            and "SkillProgram" in self.schemas
        ):
            self.validator.validate(payload["program"], self.schemas["SkillProgram"])
        if kind == "extension" and "ExtensionManifest" in self.schemas:
            self.validator.validate(payload.get("manifest"), self.schemas["ExtensionManifest"])
        for field, target_kind in (
            ("requiredToolIds", "tool"),
            ("toolIds", "tool"),
            ("skillIds", "skill"),
            ("knowledgeBaseIds", "knowledge"),
        ):
            values = payload.get(field, [])
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                raise DomainError(422, f"invalid {field}")
            for value in values:
                target = await self._owned(tx, account, value, target_kind)
                if not target.enabled:
                    raise DomainError(409, "referenced resource is disabled")
        if kind == "tool":
            implementation = payload.get("implementation")
            if not isinstance(implementation, dict):
                raise DomainError(422, "tool implementation is required")
            if self.implementations is not None:
                try:
                    bound = await self.implementations.bind(account, implementation)
                except DomainError as error:
                    # 第一阶段已登记的本人扩展资源仍走其原有校验，不绕过停用/摘要冲突。
                    if error.status != 404:
                        raise
                else:
                    descriptor = bound.get("descriptor")
                    if not isinstance(descriptor, dict):
                        raise DomainError(409, "tool descriptor is unavailable")
                    payload.update(bound)
                    payload["configurationSchema"] = descriptor.get(
                        "configurationSchema", {"type": "object"}
                    )
                    payload["inputSchema"] = descriptor.get("inputSchema", {"type": "object"})
                    return
            source = await self._owned(
                tx, account, str(implementation.get("sourceId", "")), "extension"
            )
            manifest = source.payload.get("manifest")
            if not isinstance(manifest, dict):
                raise DomainError(422, "invalid installed extension manifest")
            tools = manifest.get("tools", []) if isinstance(manifest, dict) else []
            definition = (
                next(
                    (
                        item
                        for item in tools
                        if isinstance(item, dict) and item.get("id") == implementation.get("toolId")
                    ),
                    None,
                )
                if isinstance(tools, list)
                else None
            )
            if (
                not source.enabled
                or not definition
                or implementation.get("version") != manifest.get("version")
            ):
                raise DomainError(422, "tool implementation version is unavailable")
            payload["configurationSchema"] = definition.get(
                "configurationSchema", {"type": "object", "additionalProperties": False}
            )
            payload["inputSchema"] = definition.get("inputSchema", {"type": "object"})
            payload["implementation"] = {**implementation, "sourceVersion": source.version}
        if kind == "extension":
            manifest = payload.get("manifest")
            if (
                not isinstance(manifest, dict)
                or manifest.get("runtime") not in {"node", "python", "mcp-stdio"}
                or not manifest.get("id")
                or not manifest.get("version")
            ):
                raise DomainError(422, "invalid extension manifest")
            entry = manifest.get("entrypoint")
            if (
                not isinstance(entry, str)
                or entry.startswith(("/", "\\"))
                or ":" in entry
                or ".." in entry.replace("\\", "/").split("/")
            ):
                raise DomainError(422, "invalid extension entrypoint")
            tools = manifest.get("tools")
            if not isinstance(tools, list) or not tools:
                raise DomainError(422, "extension must declare tools")
            for tool in tools:
                if not isinstance(tool, dict) or not tool.get("id"):
                    raise DomainError(422, "invalid tool declaration")
                for key in ("inputSchema", "configurationSchema"):
                    schema = tool.get(key, {"type": "object"})
                    if not isinstance(schema, dict):
                        raise DomainError(422, "invalid tool schema")
                    self.validator.check_schema(schema)

    async def save(
        self, account: Account, kind: str, body: dict[str, object], resource_id: str | None = None
    ) -> dict[str, object]:
        """资源与新版本短事务提交；配置验证失败保留旧版及旧凭据。"""
        self.require(account, kind)
        async with self.repository.transaction() as tx:
            await tx.lock(account.user_id)
            previous = await self._owned(tx, account, resource_id, kind) if resource_id else None
            if previous and body.get("version", previous.version) != previous.version:
                raise DomainError(409, "resource version conflict", "revision_conflict")
            resource_id = resource_id or str(uuid4())
            payload = {
                key: copy.deepcopy(value)
                for key, value in body.items()
                if key not in {"name", "description", "enabled", "published", "version"}
            }
            if previous:
                payload = {**copy.deepcopy(previous.payload), **payload}
            await self._validate_references(tx, account, kind, payload, resource_id)
            ciphertext = previous.secret_ciphertext if previous else None
            if kind == "tool":
                settings = payload.get("settings", {})
                schema = payload.get("configurationSchema", {})
                if not isinstance(settings, dict) or not isinstance(schema, dict):
                    raise DomainError(422, "invalid tool configuration")
                existing = (
                    json.loads(self.cipher.open(ciphertext, resource_id)) if ciphertext else {}
                )
                merged = merge_settings(existing, settings)
                self.validator.validate(merged, schema)
                payload["settings"], payload["configuredSecrets"] = redact_settings(merged, schema)
                ciphertext = self.cipher.seal(json.dumps(merged), resource_id)
            now = datetime.now(UTC)
            resource = Resource(
                resource_id,
                kind,
                account.user_id,
                str(body["name"]),
                str(body.get("description", "")),
                bool(body.get("enabled", True)),
                bool(body.get("published", False)),
                previous.version + 1 if previous else 1,
                payload,
                ciphertext,
                False,
                previous.created_at if previous else now,
                now,
            )
            result = public_resource(resource)
            await tx.save(resource, result)
            return result

    async def delete(self, account: Account, kind: str, resource_id: str) -> None:
        """软删除立即阻止后续执行，保留历史冻结快照。"""
        self.require(account, kind)
        async with self.repository.transaction() as tx:
            await tx.lock(account.user_id)
            resource = await self._owned(tx, account, resource_id, kind)
            for related_kind in ("agent", "skill"):
                for related in await tx.all(related_kind, account.user_id):
                    if related.id == resource_id:
                        continue
                    for field in ("toolIds", "requiredToolIds", "skillIds", "knowledgeBaseIds"):
                        values = related.payload.get(field, [])
                        if isinstance(values, list) and resource_id in values:
                            raise DomainError(409, "资源仍被其他配置引用，请先解除关联")
                    for field in ("program", "programDraft"):
                        program = related.payload.get(field)
                        if (
                            isinstance(program, dict)
                            and isinstance(program.get("stages"), list)
                            and any(
                                isinstance(stage, dict) and stage.get("skillId") == resource_id
                                for stage in program["stages"]
                            )
                        ):
                            raise DomainError(409, "技能仍被执行组合引用，请先解除关联")
            resource.deleted, resource.enabled = True, False
            resource.version += 1
            resource.updated_at = datetime.now(UTC)
            await tx.save(resource, public_resource(resource))

    async def versions(self, account: Account, kind: str, resource_id: str) -> dict[str, object]:
        """历史读取同样检查归属，快照不包含凭据明文。"""
        self.require(account, kind)
        async with self.repository.transaction() as tx:
            resource = await self._owned(tx, account, resource_id, kind)
            items = await tx.versions(resource_id)
            return {"items": items, "total": len(items), "currentVersion": resource.version}

    async def bind(
        self, account: Account, session_id: str, agent_id: str, version: int = 1
    ) -> Binding:
        """调用方先核验真实会话归属；绑定冻结所有间接工具及实现版本。"""
        account.require("sessions.run")
        async with self.repository.transaction() as tx:
            await tx.lock(account.user_id)
            _, snapshots = await self._published_resources(tx, account, agent_id)
            if self.tool_binding_resolver is not None:
                snapshots = [
                    await self.tool_binding_resolver(account, snapshot)
                    if snapshot.get("kind") == "tool"
                    else snapshot
                    for snapshot in snapshots
                ]
            binding = Binding(str(uuid4()), account.user_id, session_id, version, snapshots)
            await tx.save_binding(binding)
            return binding

    async def authorize_binding(self, account: Account, binding_id: str) -> Binding:
        """快照冻结不代表永久授权；停用或删除立即影响既有绑定。"""
        account.require("sessions.run")
        async with self.repository.transaction() as tx:
            binding = await tx.binding(binding_id)
            if not binding or binding.owner_id != account.user_id:
                raise DomainError(404, "binding not found")
            for snapshot in binding.snapshots:
                current = await tx.get(str(snapshot["id"]))
                if (
                    current is None
                    or current.deleted
                    or current.owner_id != snapshot.get("resourceOwnerId", account.user_id)
                ):
                    raise DomainError(403, "bound resource is unavailable")
                if not current.enabled or (current.kind == "agent" and not current.published):
                    raise DomainError(403, "bound resource is disabled")
                implementation = snapshot.get("implementation")
                if (
                    isinstance(implementation, dict)
                    and self.implementations is not None
                    and "sourceVersion" not in implementation
                ):
                    await self.implementations.bind(account, implementation)
            return binding

    async def execution_configuration(
        self, account: Account, binding_id: str, tool_id: str
    ) -> dict[str, object]:
        """仅可信工具调用方获取冻结版本凭据；此方法绝不接到管理读取接口。"""
        binding = await self.authorize_binding(account, binding_id)
        snapshot = next(
            (
                item
                for item in binding.snapshots
                if item.get("id") == tool_id and item.get("kind") == "tool"
            ),
            None,
        )
        if snapshot is None:
            raise DomainError(403, "tool is not bound to this session")
        async with self.repository.transaction() as tx:
            ciphertext = await tx.secret(tool_id, int(str(snapshot["version"])))
        if ciphertext is None:
            raise DomainError(409, "pinned tool configuration is unavailable")
        value = json.loads(self.cipher.open(ciphertext, tool_id))
        if not isinstance(value, dict):
            raise DomainError(409, "pinned tool configuration is invalid")
        return dict(value)
