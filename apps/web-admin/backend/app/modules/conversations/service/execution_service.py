"""会话执行命令的授权、附件准备与持久幂等收据。"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.integrations.dsh.protocol import RuntimeFailure
from app.modules.conversations.entity.do.models import ConversationReceiptRow, SessionRow
from app.modules.conversations.service.interaction_protocol import response_input
from app.modules.conversations.service.projection_service import record
from app.modules.conversations.service.views import effective_capabilities
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.conversations.service.conversation_service import ConversationService


class ExecutionService:
    """收据只防止重复派发，所有任务排序和实际执行仍由 DSH 处理。"""

    def __init__(self, conversations: ConversationService) -> None:
        self.conversations = conversations

    async def _authorize_runtime(
        self, account: Account, row: SessionRow, action: str, value: dict[str, object], native: bool
    ) -> None:
        """写入前读取设备权威状态和能力，缓存的空闲状态不能授权新的执行。"""
        params: dict[str, object] = {
            "sessionId": row.id,
            "runtimeId": row.runtime_id,
            "runtime": row.runtime_type,
            "externalSessionId": row.external_session_id,
        }
        call = self.conversations.devices.call
        observed = record(
            await call(
                account, row.connector_id, "session.getState" if native else "session.state", params
            )
        )
        state = record(observed.get("state", observed))
        if state.get("sessionId", row.id) != row.id:
            raise DomainError(502, "connector session binding mismatch")
        status = state.get("status", row.status)
        if action == "message" and status not in {"idle", "error"}:
            raise DomainError(409, f"session is {status}")
        if action == "steer" and status != "running":
            raise DomainError(409, "session is not running")
        observed = record(
            await call(
                account,
                row.connector_id,
                "session.getCapabilities" if native else "session.capabilities",
                params,
            )
        )
        source = record(observed.get("capabilitySet", observed))
        capabilities = effective_capabilities(row, source, True)["capabilities"]
        ids = (
            [
                f"catalog.{key}"
                for key in record(value.get("selections"))
                if key in {"model", "permission"}
            ]
            if action == "selections"
            else [
                {
                    "message": "session.send_message",
                    "notice": "session.interaction.approval",
                    "commands": "session.commands",
                }.get(action, f"session.{action}")
            ]
        )
        if value.get("attachments"):
            ids.append("runtime.attachment")
        for identifier in ids:
            matches = (
                [
                    item
                    for item in capabilities
                    if isinstance(item, dict) and item.get("capabilityId") == identifier
                ]
                if isinstance(capabilities, list)
                else []
            )
            if not matches or not all(
                matches[0].get(key) for key in ("supported", "available", "allowed")
            ):
                raise DomainError(409, f"session capability is unavailable: {identifier}")

    async def _release_unsubmitted_default(
        self, identifier: str, operation: str, signature: str
    ) -> None:
        # 只处理默认解析在发送之前的确定拒绝；超时、断连及其他未知结果必须保留收据。
        async with self.conversations.repository.transaction() as dao:
            await dao.lock(identifier)
            receipt = await dao.receipt(identifier, operation)
            current = await dao.session(identifier)
            if (
                receipt
                and receipt.digest == signature
                and receipt.state == "outcome_unknown"
                and current
                and not current.source.get("historyDeletedAt")
                and current.status == "starting"
                and not current.external_session_id
            ):
                await dao.remove(receipt)
                current.status = "idle"
                await self.conversations.projection.emit(
                    dao,
                    current,
                    "runtime.state.updated",
                    {"state": {"sessionId": identifier, "status": "idle"}},
                )

    async def _attachments(
        self, account: Account, session: str, values: object, native: bool
    ) -> tuple[list[dict[str, object]], list[Path]]:
        if not isinstance(values, list) or len(values) > 32:
            raise DomainError(422, "invalid attachments")
        prepared, paths = [], []
        try:
            staged = (
                await self.conversations.files.stage_session(
                    account, session, [record(value) for value in values]
                )
                if values
                else []
            )
            for identifier, content, entry in staged:
                result = {
                    "fileId": identifier,
                    **{key: entry[key] for key in ("name", "size", "sha256", "mediaType")},
                    "downloadUrl": f"/api/connector/sessions/{session}/attachments/{identifier}/content",
                    "platformOpenUrl": f"/api/sessions/{session}/attachments/{identifier}/open",
                }
                if native:
                    upload_id = uuid4().hex
                    path = (
                        self.conversations.devices.workspace(account.user_id).parent
                        / "home"
                        / "agents-anywhere"
                        / "bridge"
                        / "attachments"
                        / "staging"
                        / upload_id
                    )
                    await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
                    await asyncio.to_thread(path.write_bytes, content)
                    paths.append(path)
                    result["uploadId"] = upload_id
                prepared.append(result)
            return prepared, paths
        except BaseException:
            for path in paths:
                await asyncio.to_thread(path.unlink, missing_ok=True)
            raise

    async def message(
        self, account: Account, identifier: str, value: dict[str, object], create: bool = False
    ) -> dict[str, object]:
        row = await self.conversations.own(account, identifier, "sessions.run")
        operation = value.get("clientMessageId")
        text = value.get("text", "")
        if (
            not isinstance(operation, str)
            or not 0 < len(operation) <= 128
            or not isinstance(text, str)
            or not text.strip()
            and not value.get("attachments")
        ):
            raise DomainError(422, "message requires content and stable clientMessageId")
        signature = hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        binding_version = self.conversations.binding_version(row.agent_binding)
        async with self.conversations.repository.transaction() as dao:
            await dao.lock(identifier)
            receipt = await dao.receipt(identifier, operation)
            if receipt:
                if receipt.digest != signature:
                    raise DomainError(409, "idempotency conflict")
                if receipt.state == "completed":
                    return receipt.result or {}
                raise DomainError(
                    409,
                    "operation outcome unknown; synchronize session before retry",
                    "session_create_outcome_unknown",
                )
            current = await dao.session(identifier)
            if (
                not current
                or current.source.get("historyDeletedAt")
                or current.archived
                or not current.takeover
                or current.status not in {"idle", "error"}
                or current.source.get("availability", "available") != "available"
            ):
                raise DomainError(409, "session cannot accept a message")
        connector = await self.conversations.devices.own(account, row.connector_id, "sessions.run")
        native = connector.executor_kind == "server-agent"
        if self.conversations.devices.view(connector)["status"] != "online":
            raise DomainError(409, "connector is offline")
        if not create:
            await self._authorize_runtime(account, row, "message", value, native)
        prepared, paths = await self._attachments(
            account, identifier, value.get("attachments", []), native
        )
        try:
            params: dict[str, object] = {
                **value,
                "content": text,
                "sessionId": identifier,
                "runtimeId": row.runtime_id,
                "runtime": row.runtime_type,
                "attachments": prepared,
                "timelineAttachments": prepared,
            }
            params.pop("text", None)
            if row.external_session_id:
                params["externalSessionId"] = row.external_session_id
            if not native:
                params["cwd"] = row.cwd
            if row.agent_binding and self.conversations.prepare_agent:
                params.update(
                    await self.conversations.prepare_agent(account, identifier, row.agent_binding)
                )
            async with self.conversations.repository.transaction() as dao:
                await dao.lock(identifier)
                if await dao.receipt(identifier, operation):
                    raise DomainError(409, "operation already submitted")
                current = await dao.session(identifier)
                if (
                    not current
                    or current.source.get("historyDeletedAt")
                    or current.archived
                    or not current.takeover
                    or current.status not in {"idle", "error"}
                    or self.conversations.binding_version(current.agent_binding) != binding_version
                ):
                    raise DomainError(409, "session cannot accept a message")
                await dao.save(
                    ConversationReceiptRow(
                        session_id=identifier,
                        operation_id=operation,
                        digest=signature,
                        state="outcome_unknown",
                        result=None,
                    )
                )
                current.status = "starting"
                await self.conversations.projection.emit(
                    dao,
                    current,
                    "runtime.state.updated",
                    {"state": {"sessionId": identifier, "status": "starting"}},
                )
            method = (
                "session.createAndStart"
                if create and native
                else "session.startTurn"
                if native
                else "session.create"
                if create
                else "session.send_message"
            )
            try:
                raw = await self.conversations.devices.call(
                    account, row.connector_id, method, params
                )
            except RuntimeFailure as error:
                if (
                    native
                    and create
                    and error.code
                    in {
                        "model_default_invalid",
                        "model_default_unavailable",
                        "agent_default_invalid",
                        "agent_default_unavailable",
                        "permission_default_invalid",
                        "permission_default_unavailable",
                    }
                ):
                    await self._release_unsubmitted_default(identifier, operation, signature)
                raise
            result = record(raw)
            if result.get("ok") is False:
                raise DomainError(409, str(result.get("message", "runtime rejected message"))[:500])
            async with self.conversations.repository.transaction() as dao:
                await dao.lock(identifier)
                receipt = await dao.receipt(identifier, operation)
                current = await dao.session(identifier)
                if not receipt or not current:
                    raise DomainError(409, "session receipt unavailable")
                receipt.state, receipt.result = "completed", {"accepted": True, **result}
                external = result.get("externalSessionId")
                if isinstance(external, str) and not current.source.get("historyDeletedAt"):
                    current.external_session_id = external
                if current.status == "starting" and not current.source.get("historyDeletedAt"):
                    current.status = "running"
                await dao.save(receipt)
                await dao.save(current)
            return {"accepted": True, **result}
        finally:
            for path in paths:
                await asyncio.to_thread(path.unlink, missing_ok=True)

    async def command(
        self, account: Account, identifier: str, action: str, value: dict[str, object]
    ) -> object:
        row = await self.conversations.own(account, identifier, "sessions.run")
        # 接管表示允许平台写入；状态、同步等读取操作仍可用于只读及归档会话。
        if action in {"interrupt", "selections", "notice", "steer", "commands"}:
            if not row.takeover:
                raise DomainError(409, "session is read-only until takeover is enabled")
            if row.archived or row.source.get("availability") in {
                "unavailable",
                "deleted",
                "missing",
            }:
                raise DomainError(409, "source session is not available")
        native = (
            await self.conversations.devices.own(account, row.connector_id, "sessions.run")
        ).executor_kind == "server-agent"
        native_methods = {
            "interrupt": "session.interrupt",
            "selections": "session.updateSelections",
            "notice": "session.respondInteraction",
            "state": "session.getState",
            "sync": "runtime.sync.refresh",
            "capabilities": "session.getCapabilities",
            "notices": "session.getNotices",
            "steer": "session.steer",
            "commands": "session.runCommand",
        }
        remote_methods = {
            "interrupt": "session.interrupt",
            "selections": "session.selections.update",
            "notice": "interaction.respond",
            "state": "session.state",
            "sync": "session.sync",
            "capabilities": "session.capabilities",
            "notices": "session.notices",
            "steer": "session.steer",
            "commands": "session.command.execute",
        }
        methods = native_methods if native else remote_methods
        if action not in methods:
            raise DomainError(404, "session action unavailable")
        if action in {"interrupt", "selections", "notice", "steer", "commands"}:
            await self._authorize_runtime(account, row, action, value, native)
        params = {
            **value,
            "sessionId": identifier,
            "runtimeId": row.runtime_id,
            "runtime": row.runtime_type,
            "externalSessionId": row.external_session_id,
        }
        if action == "notice":
            action_id = value.get("actionId")
            if not isinstance(action_id, str) or not action_id:
                raise DomainError(422, "interaction actionId is required")
            notices = row.state.get("notices", [])
            notice = (
                next(
                    (
                        record(item)
                        for item in notices
                        if record(item).get("id") == value.get("noticeId")
                    ),
                    {},
                )
                if isinstance(notices, list)
                else {}
            )
            if not notice or notice.get("status", "open") != "open":
                raise DomainError(409, "interaction is already closed")
            actions = notice.get("actions", [])
            if not isinstance(actions, list) or not any(
                record(item).get("actionId", record(item).get("id")) == action_id
                for item in actions
            ):
                raise DomainError(422, "unknown interaction action")
            params["inputData"] = {
                **record(notice.get("context")),
                **response_input(notice, record(value.get("input"))),
            }
        if native and action in {"steer", "commands"}:
            raise DomainError(501, "operation is not supported by this Harness runtime")
        result = await self.conversations.devices.call(
            account, row.connector_id, methods[action], params
        )
        if (
            action in {"notice", "interrupt", "selections", "steer", "commands"}
            and record(result).get("ok") is False
        ):
            raise DomainError(
                409,
                str(record(result).get("message") or "runtime rejected the operation"),
                str(record(result).get("code") or "runtime_rejected"),
            )
        if action == "state":
            state = record(record(result).get("state", result))
            await self.conversations.projection.ingest(
                account.user_id,
                row.connector_id,
                "session.state.updated",
                {**state, "sessionId": identifier},
            )
        if action == "sync":
            await self.conversations.projection.sync(account)
        return result
