"""已有会话只登记平台事实，不发送消息、不创建执行收据或第二条执行队列。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.bo.creation import creation_fingerprint, creation_key
from app.modules.conversations.entity.do.models import SessionRow
from app.modules.conversations.entity.vo.import_dto import ImportSessionInput
from app.modules.conversations.service.target_service import SessionTargetService
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.conversations.service.conversation_service import ConversationService


class SessionImportService:
    """项目/设备/运行实例边界与幂等事务集中在导入用例。"""

    def __init__(self, conversations: ConversationService) -> None:
        self.conversations = conversations

    async def create(self, account: Account, value: ImportSessionInput) -> dict[str, object]:
        account.require("sessions.run")
        devices = self.conversations.devices
        connector = await devices.own(account, value.connectorId, "sessions.run")
        project = await SessionTargetService(self.conversations.repository, devices).resolve(
            account, value.connectorId, value.projectId, value.runtimeId, value.runtime, value.cwd
        )
        operation = value.clientMessageId or ""
        key = creation_key(account.user_id, connector.id, operation) if operation else None
        fingerprint = creation_fingerprint("import", value.model_dump())
        async with self.conversations.repository.transaction() as dao:
            await dao.lock("create:" + account.user_id + ":" + operation)
            # 与项目删除共用锁，目标校验后被删除时不得写入悬空的projectId。
            await dao.lock(value.projectId)
            current_project = await dao.project(value.projectId)
            if not current_project or current_project.owner_id != account.user_id:
                raise DomainError(404, "project not found")
            project = current_project
            prior = await dao.creation(account.user_id, key) if key else None
            if not prior and operation:
                legacy = await dao.creation(account.user_id, operation)
                if legacy and legacy.connector_id == connector.id:
                    prior = legacy
            if prior:
                if prior.source.get("creationFingerprint") != fingerprint:
                    raise DomainError(
                        409, "clientMessageId was already used for a different request"
                    )
                row = prior
            else:
                now = datetime.now(UTC)
                row = SessionRow(
                    id="sess_" + uuid4().hex,
                    owner_id=account.user_id,
                    connector_id=connector.id,
                    project_id=project.id,
                    runtime_id=value.runtimeId,
                    runtime_type=value.runtime,
                    external_session_id=value.externalSessionId,
                    creation_key=key,
                    title=value.title or "",
                    cwd=project.workspace_path,
                    status="idle",
                    takeover=True,
                    pinned=False,
                    archived=False,
                    sequence=0,
                    last_read_seq=0,
                    latest_turn_end_seq=0,
                    state={"selections": value.selections},
                    source={"creationFingerprint": fingerprint},
                    created_at=now,
                    updated_at=now,
                    sort_at=now,
                )
                await dao.save(row)
        return {
            "session": await self.conversations.view(account, row, "sessions.run"),
            "connectorResult": None,
        }
