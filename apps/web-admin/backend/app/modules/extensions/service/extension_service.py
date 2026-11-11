"""来源目录、安装发布与版本解析，管理配置和执行权限保持分离。"""

import copy
import io
import json
import tempfile
import zipfile
from builtins import list as List
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.infrastructure.schema_validation import JsonSchemaValidator
from app.modules.extensions.dao.extension_dao import ExtensionDao
from app.modules.extensions.entity.do.models import ExtensionSourceRow, ExtensionVersionRow
from app.modules.extensions.entity.vo.extensions import (
    InstallInput,
    McpConnectInput,
    McpDiscoveryInput,
    SourceUpdateInput,
)
from app.modules.extensions.service.installer import ExtensionInstaller, Installation
from app.modules.extensions.service.mcp_client import McpClient, schema_digest
from app.modules.extensions.service.process import entrypoint, run_process, runtime_command
from app.modules.extensions.service.validation import decode_archive, digest, manifest_definition
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.service.ports import ResourceCipher

Audit = Callable[[str, str, str, dict[str, object]], Awaitable[None]]
BuiltinExecutor = Callable[
    [Account, str, dict[str, object], dict[str, object], dict[str, object]],
    Awaitable[dict[str, object]],
]


class ExtensionService:
    """发布只改变活动版本，已绑定版本保留；停用即时阻断后续调用。"""

    def __init__(
        self,
        database: Database,
        cipher: ResourceCipher,
        directory: Path,
        builtin_manifest: Path,
        allowed_origins: str = "",
        audit: Audit | None = None,
    ) -> None:
        self.database, self.cipher, self.audit = database, cipher, audit
        self.builtin = manifest_definition(json.loads(builtin_manifest.read_text("utf-8")))
        self.builtin_digest = digest(self.builtin["tools"])
        self.mcp = McpClient(allowed_origins)
        self.installer = ExtensionInstaller(directory / "packages", self.mcp)
        self.work_root = directory / "calls"
        self.executor: BuiltinExecutor | None = None
        self.validator = JsonSchemaValidator()

    async def list(self, account: Account) -> List[dict[str, object]]:
        """编辑者能选择实现，但只有安装权限可以安装或重新授权可执行代码。"""
        account.require("agents.manage")
        result: List[dict[str, object]] = [
            {
                "id": self.builtin["id"],
                "name": self.builtin["name"],
                "kind": "builtin",
                "enabled": True,
                "revision": 1,
                "activeVersion": self.builtin["version"],
                "status": "ready",
                "credentialConfigured": False,
                "tools": copy.deepcopy(self.builtin["tools"]),
                "versions": [
                    {
                        "version": self.builtin["version"],
                        "digest": self.builtin_digest,
                        "createdAt": "",
                    }
                ],
                "createdAt": "",
                "updatedAt": "",
            }
        ]
        async with self.database.sessions.begin() as session:
            for source in await ExtensionDao.sources(session):
                versions = await ExtensionDao.versions(session, source.id)
                active = next(
                    (item for item in versions if item.version == source.active_version), None
                )
                manifest = active.manifest if active else {}
                raw_skills = manifest.get("skills", [])
                skills = (
                    [
                        {
                            key: item.get(key)
                            for key in ("id", "name", "description", "requiredToolIds")
                        }
                        for item in raw_skills
                        if isinstance(item, dict)
                    ]
                    if isinstance(raw_skills, list)
                    else []
                )
                result.append(
                    {
                        "id": source.id,
                        "name": source.name,
                        "kind": source.kind,
                        "enabled": source.enabled,
                        "revision": source.revision,
                        "activeVersion": source.active_version,
                        "status": source.status,
                        "diagnostic": source.diagnostic,
                        "endpoint": source.endpoint,
                        "credentialConfigured": bool(source.secret_ciphertext),
                        "tools": manifest.get("tools", []),
                        "skills": skills,
                        "versions": [
                            {
                                "version": item.version,
                                "digest": item.digest,
                                "createdAt": item.created_at.isoformat(),
                            }
                            for item in versions
                        ],
                        "createdAt": source.created_at.isoformat(),
                        "updatedAt": source.updated_at.isoformat(),
                    }
                )
        return result

    async def _publish(
        self,
        account: Account,
        identifier: str,
        name: str,
        kind: str,
        version: str,
        checksum: str,
        manifest: dict[str, object],
        revision: int | None,
        directory: Path | None = None,
        endpoint: str | None = None,
        token: str | None = None,
    ) -> None:
        if identifier == self.builtin["id"]:
            raise DomainError(409, "不能覆盖内置扩展")
        async with self.database.sessions.begin() as session:
            await lock_transaction(session, "extension:" + identifier)
            old = await ExtensionDao.source(session, identifier)
            if old and old.revision != revision:
                raise DomainError(409, "扩展已被修改，请刷新后重试", "revision_conflict")
            if old and (old.kind != kind or old.endpoint != endpoint):
                raise DomainError(409, "更换扩展类型或MCP地址必须创建新来源")
            installed = await ExtensionDao.version(session, identifier, version)
            if installed and installed.digest != checksum:
                raise DomainError(409, "同一版本不能替换内容，请提高版本号")
            now = datetime.now(UTC)
            source = old or ExtensionSourceRow(
                id=identifier, installed_by=account.user_id, created_at=now, revision=0
            )
            source.name, source.kind, source.active_version = name, kind, version
            source.enabled, source.status, source.diagnostic = True, "ready", None
            source.endpoint = endpoint
            source.secret_ciphertext = (
                self.cipher.seal(token, "extension:" + identifier) if token else None
            )
            source.revision += 1
            source.updated_at = now
            await ExtensionDao.save_source(session, source)
            if installed is None:
                await ExtensionDao.add_version(
                    session,
                    ExtensionVersionRow(
                        source_id=identifier,
                        version=version,
                        digest=checksum,
                        manifest=manifest,
                        installation_path=str(directory) if directory else None,
                        created_at=now,
                    ),
                )
        if self.audit:
            await self.audit(
                account.user_id,
                "extension.install",
                identifier,
                {"version": version, "digest": checksum},
            )

    async def install(self, account: Account, body: InstallInput) -> dict[str, object]:
        """安装包与当前来源身份匹配后发布；安装失败不修改来源记录。"""
        account.require("extensions.manage")
        result = await self.installer.install(decode_archive(body.contentBase64, 16 * 1024 * 1024))
        manifest = result.manifest
        if body.expectedSourceId and manifest["id"] != body.expectedSourceId:
            raise DomainError(409, "上传包不属于所选扩展来源")
        await self._publish(
            account,
            str(manifest["id"]),
            str(manifest["name"]),
            "package",
            str(manifest["version"]),
            result.digest,
            manifest,
            body.revision,
            result.directory,
        )
        return {"id": manifest["id"], "version": manifest["version"], "digest": result.digest}

    async def _token(
        self, identifier: str | None, endpoint: str, supplied: str | None
    ) -> str | None:
        if supplied is not None or identifier is None:
            return supplied
        async with self.database.sessions.begin() as session:
            source = await ExtensionDao.source(session, identifier)
            if source is None:
                raise DomainError(404, "扩展来源不存在")
            if source.kind != "mcp-http" or source.endpoint != endpoint:
                raise DomainError(422, "已有凭据只能用于原MCP端点")
            return (
                self.cipher.open(source.secret_ciphertext, "extension:" + source.id)
                if source.secret_ciphertext
                else None
            )

    async def discover(self, account: Account, body: McpDiscoveryInput) -> dict[str, object]:
        """发现不等于授权，界面需确认所选工具及发现摘要后再连接。"""
        account.require("extensions.manage")
        token = await self._token(body.id, body.endpoint, body.token)
        async with self.mcp.connect(endpoint=body.endpoint, token=token) as session:
            tools = await self.mcp.discover(session)
        return {"tools": tools, "discoveryDigest": digest(tools)}

    async def connect(self, account: Account, body: McpConnectInput) -> dict[str, object]:
        """重新发现核对界面确认的结果，消除发现与保存间的Schema变化。"""
        account.require("extensions.manage")
        token = await self._token(body.id if body.revision else None, body.endpoint, body.token)
        discovery = await self.discover(
            account, McpDiscoveryInput(endpoint=body.endpoint, token=token)
        )
        if discovery["discoveryDigest"] != body.discoveryDigest:
            raise DomainError(409, "发现结果已变化，请重新检查并选择工具")
        raw_tools = discovery["tools"]
        assert isinstance(raw_tools, list)
        selected = set(body.selectedToolIds)
        tools = [item for item in raw_tools if isinstance(item, dict) and item["id"] in selected]
        if len(tools) != len(selected):
            raise DomainError(422, "选择了未发现的工具")
        manifest: dict[str, object] = {"tools": tools, "endpoint": body.endpoint}
        await self._publish(
            account,
            body.id,
            body.name,
            "mcp-http",
            body.version,
            digest(manifest),
            manifest,
            body.revision,
            endpoint=body.endpoint,
            token=token,
        )
        return {"id": body.id, "version": body.version}

    async def _stored(
        self, identifier: str, version: str = ""
    ) -> tuple[ExtensionSourceRow, ExtensionVersionRow]:
        async with self.database.sessions.begin() as session:
            source = await ExtensionDao.source(session, identifier)
            installed = (
                await ExtensionDao.version(session, identifier, version or source.active_version)
                if source
                else None
            )
            if source is None or installed is None:
                raise DomainError(404, "扩展来源或版本不存在")
            return source, installed

    async def bind(self, account: Account, reference: dict[str, object]) -> dict[str, object]:
        """解析不可变工具实现，不返回安装路径和来源凭据。"""
        if "agents.manage" not in account.permissions:
            account.require("sessions.run")
        else:
            account.require("agents.manage")
        if reference.get("sourceId") == self.builtin["id"]:
            if reference.get("version") != self.builtin["version"]:
                raise DomainError(409, "内置工具版本不可用")
            manifest, checksum = self.builtin, self.builtin_digest
        else:
            source, installed = await self._stored(
                str(reference.get("sourceId", "")), str(reference.get("version", ""))
            )
            if not source.enabled:
                raise DomainError(403, "扩展来源已停用")
            if source.status != "ready":
                raise DomainError(409, "扩展来源需要重新检查并授权")
            manifest, checksum = installed.manifest, installed.digest
        if reference.get("digest") and reference["digest"] != checksum:
            raise DomainError(409, "工具实现内容已改变，请绑定新版本")
        tools = manifest.get("tools", [])
        tool = (
            next(
                (
                    item
                    for item in tools
                    if isinstance(item, dict) and item.get("id") == reference.get("toolId")
                ),
                None,
            )
            if isinstance(tools, list)
            else None
        )
        if tool is None:
            raise DomainError(422, "工具实现不存在")
        return {
            "implementation": {key: reference[key] for key in ("sourceId", "version", "toolId")}
            | {"digest": checksum},
            "descriptor": copy.deepcopy(tool),
        }

    async def check(
        self, account: Account, identifier: str, version: str = ""
    ) -> dict[str, object]:
        """网络检查不持锁，写诊断时使用先前revision防止覆盖后续修改。"""
        account.require("extensions.manage")
        source, installed = await self._stored(identifier, version)
        diagnostic: str | None = None
        try:
            if source.kind == "mcp-http":
                token = await self._token(source.id, source.endpoint or "", None)
                async with self.mcp.connect(endpoint=source.endpoint, token=token) as session:
                    actual = {str(item["id"]): item for item in await self.mcp.discover(session)}
                tools = installed.manifest.get("tools", [])
                if not isinstance(tools, list) or any(
                    not isinstance(tool, dict)
                    or str(tool["id"]) not in actual
                    or schema_digest(tool) != schema_digest(actual[str(tool["id"])])
                    for tool in tools
                ):
                    raise DomainError(409, "MCP工具或Schema已改变，需重新发现并授权")
            elif installed.installation_path:
                await self.installer.check(
                    Installation(
                        installed.manifest, installed.digest, Path(installed.installation_path)
                    )
                )
            else:
                raise DomainError(503, "扩展安装目录缺失")
        except DomainError as error:
            diagnostic = error.detail
        async with self.database.sessions.begin() as session:
            await lock_transaction(session, "extension:" + identifier)
            current = await ExtensionDao.source(session, identifier)
            if current is None or current.revision != source.revision:
                raise DomainError(409, "检查期间来源已修改，请刷新")
            current.status = "needs-review" if diagnostic else "ready"
            current.diagnostic = diagnostic
            current.revision += 1
            current.updated_at = datetime.now(UTC)
        return {
            "ok": diagnostic is None,
            "status": "needs-review" if diagnostic else "ready",
            "diagnostic": diagnostic,
        }

    async def update(
        self, account: Account, identifier: str, body: SourceUpdateInput
    ) -> dict[str, object]:
        """切换版本及停用具备乐观锁；故障来源不能直接启用。"""
        account.require("extensions.manage")
        async with self.database.sessions.begin() as session:
            await lock_transaction(session, "extension:" + identifier)
            source = await ExtensionDao.source(session, identifier)
            if source is None:
                raise DomainError(404, "扩展来源不存在")
            if source.revision != body.revision:
                raise DomainError(409, "扩展已修改，请刷新", "revision_conflict")
            if (
                body.version
                and await ExtensionDao.version(session, identifier, body.version) is None
            ):
                raise DomainError(404, "扩展版本不存在")
            if body.enabled is True and source.status != "ready":
                raise DomainError(409, "扩展检查尚未通过")
            if body.enabled is not None:
                source.enabled = body.enabled
            if body.version:
                source.active_version = body.version
            source.revision += 1
            source.updated_at = datetime.now(UTC)
        if self.audit:
            await self.audit(
                account.user_id, "extension.update", identifier, body.model_dump(exclude_none=True)
            )
        return {"ok": True}

    async def skill_archive(
        self, account: Account, identifier: str, version: str, skill_id: str
    ) -> bytes:
        """只导出清单声明技能目录中的数据文件，执行代码不会进入技能资源。"""
        account.require("agents.manage")
        source, installed = await self._stored(identifier, version)
        skills = installed.manifest.get("skills", [])
        skill = (
            next(
                (item for item in skills if isinstance(item, dict) and item.get("id") == skill_id),
                None,
            )
            if isinstance(skills, list)
            else None
        )
        if (
            not source.enabled
            or source.kind != "package"
            or not installed.installation_path
            or skill is None
        ):
            raise DomainError(404, "扩展技能不可用")
        root = entrypoint(Path(installed.installation_path), str(skill["entrypoint"])).parent
        output = io.BytesIO()
        size = 0
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for index, path in enumerate(root.rglob("*")):
                if index > 3000:
                    raise DomainError(413, "技能目录过大")
                if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                    raise DomainError(422, "技能目录包含链接")
                relative = path.relative_to(root).as_posix()
                if path.is_file() and (
                    relative == "SKILL.md" or relative.startswith(("references/", "templates/"))
                ):
                    size += path.stat().st_size
                    if size > 24 * 1024 * 1024:
                        raise DomainError(413, "技能资料过大")
                    archive.write(path, relative)
        return output.getvalue()

    async def execute(
        self,
        account: Account,
        reference: dict[str, object],
        arguments: dict[str, object],
        settings: dict[str, object],
        context: dict[str, object],
    ) -> dict[str, object]:
        """调用方必须先授权会话冻结绑定；这里重新校验来源与声明权限。"""
        bound = await self.bind(account, reference)
        tool = bound["descriptor"]
        assert isinstance(tool, dict)
        permissions = tool["permissions"]
        assert isinstance(permissions, list)
        for permission in permissions:
            account.require(str(permission))
        schema = tool["inputSchema"]
        assert isinstance(schema, dict)
        self.validator.validate(arguments, schema)
        if reference["sourceId"] == self.builtin["id"]:
            if self.executor is None:
                raise DomainError(503, "内置工具实现尚未装配")
            result = await self.executor(
                account, str(reference["toolId"]), arguments, settings, context
            )
        else:
            source, installed = await self._stored(
                str(reference["sourceId"]), str(reference["version"])
            )
            if source.kind == "mcp-http":
                token = await self._token(source.id, source.endpoint or "", None)
                async with self.mcp.connect(endpoint=source.endpoint, token=token) as session:
                    result = await self.mcp.call(session, tool, arguments)
            else:
                if not installed.installation_path:
                    raise DomainError(503, "扩展安装目录缺失")
                command = runtime_command(
                    Path(installed.installation_path), installed.manifest, self.installer.node
                )
                self.work_root.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryDirectory(prefix="tool-", dir=self.work_root) as work:
                    if installed.manifest["runtime"] == "mcp-stdio":
                        async with self.mcp.connect(
                            command=command, directory=Path(work)
                        ) as session:
                            result = await self.mcp.call(session, tool, arguments)
                    else:
                        result = await run_process(
                            command,
                            Path(work),
                            {
                                "operation": "execute",
                                "toolId": reference["toolId"],
                                "arguments": arguments,
                                "settings": settings,
                                "context": context,
                            },
                            float(str(tool["timeoutSeconds"])),
                        )
        output_schema = tool.get("outputSchema")
        if isinstance(output_schema, dict):
            self.validator.validate(result.get("structuredContent", result), output_schema)
        return result
