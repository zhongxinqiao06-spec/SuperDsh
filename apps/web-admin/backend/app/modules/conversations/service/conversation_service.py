"""工作台会话公共入口，执行、投影、分享分别由明确子用例承担。"""

from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from uuid import uuid4

from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.integrations.dsh.protocol import RuntimeFailure
from app.modules.conversations.dao.conversation_dao import ConversationRepository
from app.modules.conversations.entity.bo.creation import creation_fingerprint, creation_key
from app.modules.conversations.entity.do.models import SessionRow
from app.modules.conversations.entity.vo.conversation_dto import CreateSessionInput
from app.modules.conversations.entity.vo.timeline_query import query_integer
from app.modules.conversations.service.batch_service import SessionBatchService
from app.modules.conversations.service.import_service import SessionImportService
from app.modules.conversations.service.lifecycle_service import SessionLifecycleService
from app.modules.conversations.service.listing_service import SessionListingService
from app.modules.conversations.service.project_service import ProjectService
from app.modules.conversations.service.projection_service import ProjectionService
from app.modules.conversations.service.query_service import ConversationQueryService
from app.modules.conversations.service.target_service import SessionTargetService
from app.modules.conversations.service.views import (
    effective_capabilities,
    runtime_state_view,
    session_view,
)
from app.modules.devices.service.device_service import DeviceService
from app.modules.files.service.file_service import FileService
from app.modules.identity.entity.bo.models import Account


class ConversationService:
    """只保存管理端事实与命令收据，Agent 工作仍交给 DSH 原队列。"""

    def __init__(self, database: Database, devices: DeviceService, files: FileService) -> None:
        self.repository = ConversationRepository(database)
        self.devices, self.files = devices, files
        self.projection = ProjectionService(self.repository, devices)
        self.queries = ConversationQueryService(self)
        self.lists = SessionListingService(self)
        self.batch = SessionBatchService(self)
        self.lifecycle = SessionLifecycleService(self)
        self.projects = ProjectService(self.repository, devices)
        self.imports = SessionImportService(self)
        self.agent_resolver: Callable[[Account, str], Awaitable[dict[str, object]]] | None = None
        self.prepare_agent: (
            Callable[[Account, str, dict[str, object]], Awaitable[dict[str, object]]] | None
        ) = None
        self.binding_guard: Callable[[Account, str], Awaitable[None]] | None = None
        from app.modules.conversations.service.attachment_access_service import (
            AttachmentAccessService,
        )
        from app.modules.conversations.service.execution_service import ExecutionService
        from app.modules.conversations.service.share_service import ShareService
        from app.modules.conversations.service.ticket_service import TicketService

        self.actions = ExecutionService(self)
        self.attachments = AttachmentAccessService(self)
        self.sharing = ShareService(self)
        self.tickets = TicketService(self.repository, devices.identity, devices.cipher)
        devices.on_notification = lambda row, method, params: self.projection.ingest(
            row.owner_id, row.id, method, params
        )

    async def own(
        self, account: Account, identifier: str, permission: str = "sessions.read"
    ) -> SessionRow:
        """会话、附件、终端和分享统一从此处校验资源归属。"""
        account.require(permission)
        async with self.repository.transaction() as dao:
            row = await dao.session(identifier)
        if not row or row.owner_id != account.user_id or row.source.get("historyDeletedAt"):
            raise DomainError(404, "session not found")
        return row

    async def get_session(self, account: Account, identifier: str) -> dict[str, object]:
        """跨领域读取会话只返回授权后的公开视图，不传递 ORM 实体。"""
        return await self.view(account, await self.own(account, identifier))

    async def read_attachment(
        self,
        account: Account,
        session_id: str,
        name: str,
        hash_prefix: str | None = None,
        file_id: str | None = None,
    ) -> tuple[bytes, dict[str, object]]:
        """工具读取会话附件先核验会话归属，再核验确切文件引用及可选摘要。"""
        await self.get_session(account, session_id)
        if file_id:
            result = await self.files.read_bound(account, file_id, "session", session_id)
            if hash_prefix and not str(result[1]["sha256"]).startswith(hash_prefix.lower()):
                raise DomainError(409, "attachment digest mismatch")
            return result
        return await self.files.read_reference(account, "session", session_id, name, hash_prefix)

    async def binding(self, account: Account, identifier: str) -> dict[str, object] | None:
        """获取已经冻结的业务智能体绑定，用于工具执行二次授权。"""
        return (await self.own(account, identifier)).agent_binding

    async def attach_binding(
        self,
        account: Account,
        identifier: str,
        binding: dict[str, object],
        expected_version: int = 1,
    ) -> None:
        """资源快照仅能补入刚选定的绑定版本，迟到的安装不能覆盖新选择。"""
        await self.own(account, identifier, "sessions.run")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.session(identifier)
            if (
                not row
                or row.source.get("historyDeletedAt")
                or row.status not in {"idle", "error"}
                or self.binding_version(row.agent_binding) != expected_version
                or (row.agent_binding or {}).get("bindingId")
            ):
                raise DomainError(409, "session binding is frozen")
            row.agent_binding = {**(row.agent_binding or {}), **binding}
            await dao.save(row)

    @staticmethod
    def binding_version(binding: dict[str, object] | None) -> int:
        """早期已有绑定默认首版，未选择智能体时版本为零。"""
        return int(str(binding.get("bindingVersion", 1))) if binding else 0

    async def binding_view(self, account: Account, identifier: str) -> dict[str, object]:
        """旧桌面与网页都只需要选择摘要和并发版本，不公开内部冻结资源。"""
        binding = await self.binding(account, identifier)
        definition = binding.get("definition") if binding else None
        return {
            "agentDefinition": {key: definition.get(key) for key in ("id", "name", "version")}
            if isinstance(definition, dict)
            else None,
            "bindingVersion": self.binding_version(binding),
        }

    async def view(
        self, account: Account, row: SessionRow, permission: str = "sessions.read"
    ) -> dict[str, object]:
        """返回该用例已授权的会话视图，写操作不在提交后额外要求无关读取权限。"""
        connector = await self.devices.own(account, row.connector_id, permission)
        return session_view(row, self.devices.view(connector)["status"] == "online")

    async def listing(
        self, account: Account, filters: dict[str, str], inventory: bool = False
    ) -> dict[str, object]:
        """完整目录与页面查询共用授权和排序，分页不依赖锚点会话存活。"""
        return await self.lists.listing(account, filters, inventory)

    async def create(
        self, account: Account, value: CreateSessionInput, start: bool = True
    ) -> dict[str, object]:
        account.require("sessions.run")
        connector = await self.devices.own(account, value.connectorId, "sessions.run")
        if start:
            # 发送前先验证实际目标；内部合成事实准备不暴露为绕过校验的HTTP入口。
            await SessionTargetService(self.repository, self.devices).resolve(
                account,
                value.connectorId,
                value.projectId,
                value.runtimeId,
                value.runtime,
                value.cwd,
            )
        binding = None
        if value.agentDefinitionId:
            if connector.executor_kind != "server-agent" or not self.agent_resolver:
                raise DomainError(409, "agent binding unavailable for this connector")
            binding = await self.agent_resolver(account, value.agentDefinitionId)
            binding = {**binding, "bindingVersion": 1}
        cwd = (
            str(self.devices.workspace(account.user_id))
            if connector.executor_kind == "server-agent"
            else value.cwd or ""
        )
        scoped_key = creation_key(account.user_id, value.connectorId, value.clientMessageId)
        fingerprint = creation_fingerprint("start" if start else "internal", value.model_dump())
        async with self.repository.transaction() as dao:
            await dao.lock("create:" + account.user_id + ":" + value.clientMessageId)
            prior = await dao.creation(account.user_id, scoped_key)
            if not prior:
                legacy = await dao.creation(account.user_id, value.clientMessageId)
                if legacy and legacy.connector_id == value.connectorId:
                    prior = legacy
            if prior:
                if prior.source.get("historyDeletedAt"):
                    raise DomainError(409, "原会话已删除，请新建会话", "session_deleted")
                if prior.connector_id != value.connectorId or prior.runtime_id != value.runtimeId:
                    raise DomainError(409, "creation idempotency conflict")
                if prior.source.get("creationFingerprint") not in {None, fingerprint}:
                    raise DomainError(
                        409, "clientMessageId was already used for a different request"
                    )
                if prior.source.get("creationFingerprint") is None:
                    raise DomainError(
                        409,
                        "session creation outcome is unknown; check the existing session before sending again",
                        "session_create_outcome_unknown",
                    )
                row = prior
            else:
                if value.projectId:
                    # 删除项目和写入首个会话必须串行，避免校验后出现悬空归属。
                    await dao.lock(value.projectId)
                    project = await dao.project(value.projectId)
                    if (
                        not project
                        or project.owner_id != account.user_id
                        or project.connector_id != value.connectorId
                    ):
                        raise DomainError(404, "project not found")
                    cwd = project.workspace_path
                    if connector.executor_kind == "server-agent" and cwd != str(
                        self.devices.workspace(account.user_id)
                    ):
                        raise DomainError(422, "server Agent workspace is product-owned")
                now = datetime.now(UTC)
                row = SessionRow(
                    id="sess_" + uuid4().hex,
                    owner_id=account.user_id,
                    connector_id=value.connectorId,
                    project_id=value.projectId,
                    runtime_id=value.runtimeId,
                    runtime_type=value.runtime,
                    creation_key=scoped_key,
                    title=value.title
                    if value.title != "新会话"
                    else value.text.strip()[:80] or "新会话",
                    cwd=cwd,
                    status="idle",
                    archived=False,
                    pinned=False,
                    # 平台创建的会话由当前用户直接控制；外来库存会话仍需显式接管。
                    takeover=True,
                    sequence=0,
                    last_read_seq=0,
                    latest_turn_end_seq=0,
                    state={},
                    source={"creationFingerprint": fingerprint},
                    agent_binding=binding,
                    created_at=now,
                    updated_at=now,
                    sort_at=now,
                )
                await dao.save(row)
        if start:
            result = await self.actions.message(
                account,
                row.id,
                value.model_dump(
                    exclude={
                        "connectorId",
                        "projectId",
                        "runtimeId",
                        "runtime",
                        "cwd",
                        "title",
                        "agentDefinitionId",
                    }
                ),
                create=True,
            )
            return {**result, "session": await self.view(account, await self.own(account, row.id))}
        return {"session": await self.view(account, row)}

    async def update(
        self, account: Account, identifier: str, value: dict[str, object]
    ) -> dict[str, object]:
        await self.own(account, identifier, "sessions.run")
        if set(value) - {"title", "pinned", "archived", "read", "takeover"}:
            raise DomainError(422, "unsupported session changes")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.session(identifier)
            if not row or row.source.get("historyDeletedAt"):
                raise DomainError(404, "session not found")
            if "title" in value:
                title = value["title"]
                if not isinstance(title, str) or not title.strip() or len(title) > 500:
                    raise DomainError(422, "invalid title")
                row.title = title.strip()
            for key in ("pinned", "archived", "takeover"):
                if key in value:
                    if not isinstance(value[key], bool):
                        raise DomainError(422, "invalid session state")
                    setattr(row, key, value[key])
                    if key in {"pinned", "archived"}:
                        setattr(row, key + "_at", datetime.now(UTC) if value[key] else None)
            if value.get("read") is True:
                row.last_read_seq = row.sequence
            await self.projection.emit(
                dao, row, "session.meta.updated", {"session": session_view(row)}
            )
        return {"session": await self.view(account, row)}

    async def timeline(
        self, account: Account, identifier: str, query: Mapping[str, str] | None = None
    ) -> dict[str, object]:
        """返回有界时间线和同一提交边界的恢复游标。"""
        return await self.queries.timeline(account, identifier, query or {})

    async def snapshot(
        self, account: Account, identifier: str, query: Mapping[str, str] | None = None
    ) -> dict[str, object]:
        """完整状态按请求上限加载最新消息，以消息读取序列建立恢复起点。"""
        await self.projection.sync(account)
        row = await self.own(account, identifier)
        limit = query_integer((query or {}).get("limit"), 100, 1, 500)
        timeline = await self.timeline(account, identifier, {"limit": str(limit)})
        session = await self.view(account, row)
        capabilities = await self.runtime_capabilities(account, identifier)
        return {
            "session": session,
            "state": runtime_state_view(row),
            "timeline": {key: timeline[key] for key in ("items", "nextSeq", "hasMore")},
            "approvals": row.state.get("approvals", []),
            "notices": row.state.get("notices", []),
            "runtimeCapabilities": capabilities,
            "effectiveCapabilities": effective_capabilities(
                row, capabilities, session.get("connectorStatus") == "online"
            ),
            "catalogs": row.state.get("catalogs", {}),
            "eventCursor": f"seq:{timeline['nextSeq']}",
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def runtime_capabilities(self, account: Account, identifier: str) -> dict[str, object]:
        """在线会话读取真实能力目录，离线保留已提交快照供历史展示。"""
        row = await self.own(account, identifier)
        cached = row.state.get("capabilitySet", {})
        source = cached if isinstance(cached, dict) else {}
        connector = await self.devices.own(account, row.connector_id, "sessions.read")
        if self.devices.view(connector)["status"] == "online":
            try:
                raw = await self.devices.call(
                    account,
                    row.connector_id,
                    "session.getCapabilities"
                    if connector.executor_kind == "server-agent"
                    else "session.capabilities",
                    {
                        "sessionId": row.id,
                        "runtimeId": row.runtime_id,
                        "runtime": row.runtime_type,
                        "externalSessionId": row.external_session_id,
                    },
                    permission="sessions.read",
                    timeout_seconds=5,
                )
                if isinstance(raw, dict):
                    value = raw.get("capabilitySet", raw)
                    if isinstance(value, dict):
                        source = value
            except (DomainError, RuntimeFailure, TimeoutError, ConnectionError):
                # 读取失败不能隐式启动 Host，写入仍会重新查询真实能力并拒绝离线操作。
                pass
        return source

    async def runtime_state(self, account: Account, identifier: str) -> dict[str, object]:
        """状态入口与完整快照使用同一权威视图，控制器不拼接持久实体字段。"""
        return {"state": runtime_state_view(await self.own(account, identifier))}

    async def events(self, account: Account, identifier: str, after: int) -> dict[str, object]:
        """WS 轮询持久日志；HTTP 恢复由 recover_events 重建快照相关状态。"""
        await self.own(account, identifier)
        await self.projection.sync(account)
        async with self.repository.transaction() as dao:
            rows = await dao.events(identifier, after, 201)
        return {
            "events": [self.projection.envelope(row) for row in rows[:200]],
            "hasMore": len(rows) > 200,
            "nextCursor": f"seq:{rows[min(len(rows), 200) - 1].sequence if rows else after}",
        }

    async def recover_events(
        self, account: Account, identifier: str, query: Mapping[str, str]
    ) -> dict[str, object]:
        """HTTP 客户端断线后恢复变化，无法完整恢复时明确请求快照。"""
        return await self.queries.recover(account, identifier, query)

    async def bind_agent(
        self, account: Account, identifier: str, agent_id: str, expected_version: object = None
    ) -> dict[str, object]:
        row = await self.own(account, identifier, "sessions.run")
        if (
            not isinstance(expected_version, int)
            or isinstance(expected_version, bool)
            or expected_version < 0
        ):
            raise DomainError(422, "缺少有效绑定版本")
        connector = await self.devices.own(account, row.connector_id, "sessions.run")
        if connector.executor_kind != "server-agent":
            raise DomainError(422, "仅服务端会话支持选择平台智能体")
        if row.status not in {"idle", "error"} or row.archived or not row.takeover:
            raise DomainError(409, "请先接管并等待当前任务完成")
        if row.external_session_id:
            observed = await self.devices.call(
                account,
                row.connector_id,
                "session.getState",
                {
                    "sessionId": row.id,
                    "externalSessionId": row.external_session_id,
                    "runtimeId": row.runtime_id,
                },
            )
            state = observed.get("state", observed) if isinstance(observed, dict) else {}
            if not isinstance(state, dict) or state.get("status") not in {"idle", "error"}:
                raise DomainError(409, "请等待当前任务完成，或先确认取消任务，再切换智能体")
            if state.get("sessionId", row.id) != row.id:
                raise DomainError(502, "connector session binding mismatch")
        if not self.agent_resolver:
            raise DomainError(503, "agent binding unavailable")
        binding = await self.agent_resolver(account, agent_id)
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            current = await dao.session(identifier)
            if (
                not current
                or current.status not in {"idle", "error"}
                or current.archived
                or not current.takeover
                or self.binding_version(current.agent_binding) != expected_version
            ):
                raise DomainError(409, "智能体绑定已被修改，请刷新后重试")
            if self.binding_guard:
                await self.binding_guard(account, identifier)
            current.agent_binding = {**binding, "bindingVersion": expected_version + 1}
            await dao.save(current)
            await self.projection.emit(
                dao, current, "session.meta.updated", {"session": session_view(current)}
            )
        return await self.binding_view(account, identifier)

    async def facts(
        self, account: Account, from_date: str | None, to_date: str | None, timezone: str
    ) -> dict[str, object]:
        """提供总览所需计数事实，不暴露消息正文或启动引擎。"""
        account.require("settings.manage")
        async with self.repository.transaction() as dao:
            rows = await dao.sessions()
            sessions: list[dict[str, object]] = []
            messages = await dao.message_facts()
            for row in rows:
                sessions.append(
                    {
                        "userId": row.owner_id,
                        "id": row.id,
                        "createdAt": row.created_at.isoformat(),
                        "agentType": row.runtime_type,
                    }
                )
            # 无时间戳的历史投影不能伪造为会话最近更新时间，以免旧消息每天重复增长。
        return {"sessions": sessions, "messages": messages}
