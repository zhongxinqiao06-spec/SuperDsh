"""将已提交 DSH 投影及远端通知转为可恢复的工作台事实。"""

import json
from datetime import UTC, datetime
from typing import cast

from app.infrastructure.errors import DomainError
from app.integrations.dsh.protocol import contract
from app.modules.conversations.dao.conversation_dao import ConversationDao, ConversationRepository
from app.modules.conversations.entity.do.models import (
    ConversationEventRow,
    ProjectionCursorRow,
    SessionRow,
    TimelineRow,
)
from app.modules.conversations.service.event_protocol import event_envelope
from app.modules.conversations.service.interaction_protocol import notice_view, runtime_error_notice
from app.modules.conversations.service.runtime_failure import runtime_failure_items
from app.modules.conversations.service.timeline_protocol import item_timestamp
from app.modules.conversations.service.views import session_view
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account


def record(value: object) -> dict[str, object]:
    """协议对象必须显式收敛，非对象不会参与动态属性访问。"""
    return cast(dict[str, object], value) if isinstance(value, dict) else {}


class ProjectionService:
    """游标与领域事件一起提交；重放和重启不会产生重复时间线。"""

    def __init__(self, repository: ConversationRepository, devices: DeviceService) -> None:
        self.repository, self.devices = repository, devices
        self.metadata = contract()

    async def emit(
        self, dao: ConversationDao, row: SessionRow, kind: str, payload: dict[str, object]
    ) -> None:
        """同一会话单调序号由事务锁保护，持久化成功后才对外可见。"""
        row.sequence += 1
        row.updated_at = datetime.now(UTC)
        if kind == "session.meta.updated":
            # 旧协议要求 payload.session 是此次提交后的完整视图，不能透传通知
            # 或复用调用者在序号递增之前构造的快照。在线事实只经设备公开接口读取。
            online = await self.devices.connection_online(row.owner_id, row.connector_id)
            payload = {"session": session_view(row, online)}
        await dao.save(
            ConversationEventRow(
                session_id=row.id,
                sequence=row.sequence,
                type=kind,
                payload=payload,
                emitted_at=row.updated_at,
            )
        )
        await dao.save(row)

    def envelope(self, event: ConversationEventRow) -> dict[str, object]:
        return event_envelope(
            event.session_id, event.sequence, event.type, event.payload, event.emitted_at
        )

    async def ingest(
        self, owner: str, connector: str, method: str, params: dict[str, object]
    ) -> dict[str, object]:
        async with self.repository.transaction() as dao:
            await self._notification(dao, owner, connector, method, params)
        return {"accepted": True}

    async def sync(self, account: Account) -> None:
        """读取有限页已持久批次，账号无执行权时仍可读最后已投影历史。"""
        runtime = self.devices.runtime_getter()
        if not runtime or "sessions.run" not in account.permissions:
            return
        async with self.repository.transaction() as dao:
            cursor = await dao.cursor(account.user_id)
            after = cursor.cursor if cursor else 0
        batches = await runtime.events(account.user_id, after)
        for batch in batches:
            identifier = batch.get("cursor")
            if not isinstance(identifier, int):
                raise DomainError(502, "invalid runtime cursor")
            async with self.repository.transaction() as dao:
                await dao.lock("projection:" + account.user_id)
                cursor = await dao.cursor(account.user_id)
                if cursor and cursor.cursor >= identifier:
                    continue
                if not cursor:
                    cursor = ProjectionCursorRow(owner_id=account.user_id, cursor=0, snapshot=None)
                operations = record(batch.get("batch")).get("operations", [])
                if not isinstance(operations, list):
                    raise DomainError(502, "invalid runtime operations")
                for operation in operations:
                    await self._operation(dao, account, cursor, record(operation))
                cursor.cursor = identifier
                await dao.save(cursor)

    async def _operation(
        self,
        dao: ConversationDao,
        account: Account,
        cursor: ProjectionCursorRow,
        operation: dict[str, object],
    ) -> None:
        kind = operation.get("kind")
        connector = self.devices.native_ids(account.user_id)[0]
        if kind == "notifications":
            notifications = operation.get("notifications")
            if not isinstance(notifications, list):
                raise DomainError(502, "invalid runtime notifications")
            for event in notifications:
                value = record(event)
                await self._notification(
                    dao,
                    account.user_id,
                    connector,
                    str(value.get("method", "")),
                    record(value.get("params")),
                )
        elif kind == "snapshot.begin":
            cursor.snapshot = {"begin": operation, "items": []}
        elif kind in {"snapshot.items", "snapshot.commit", "snapshot.abort"}:
            snapshot = cursor.snapshot
            begin = record(snapshot.get("begin")) if snapshot else {}
            if (
                not snapshot
                or operation.get("snapshotId") != begin.get("snapshotId")
                or operation.get("sessionId") != begin.get("sessionId")
            ):
                raise DomainError(502, "invalid snapshot identity")
            items = snapshot.get("items")
            if not isinstance(items, list):
                raise DomainError(502, "invalid snapshot items")
            if kind == "snapshot.abort":
                cursor.snapshot = None
            elif kind == "snapshot.items":
                incoming = operation.get("items")
                if not isinstance(incoming, list):
                    raise DomainError(502, "invalid snapshot items")
                merged = [*items, *incoming]
                ids = [record(item).get("id") for item in merged]
                if (
                    len(ids) != len(set(str(item) for item in ids))
                    or any(
                        record(item).get("sessionId") != begin.get("sessionId") for item in merged
                    )
                    or len(json.dumps(merged).encode()) > 32 * 1024 * 1024
                ):
                    raise DomainError(502, "invalid or oversized snapshot")
                cursor.snapshot = {"begin": begin, "items": merged}
            else:
                if len(items) != operation.get("totalItems") or operation.get(
                    "throughSeq"
                ) != begin.get("throughSeq"):
                    raise DomainError(502, "incomplete snapshot")
                await self._notification(
                    dao,
                    account.user_id,
                    connector,
                    "session.meta.upsert",
                    {**record(begin.get("meta")), "sessionId": operation["sessionId"]},
                )
                await self._notification(
                    dao,
                    account.user_id,
                    connector,
                    "timeline.sync",
                    {"sessionId": operation["sessionId"], "items": items, "complete": True},
                )
                cursor.snapshot = None
        elif not str(kind).startswith("checkpoint.") and kind != "workspace.inventory":
            raise DomainError(502, "unknown projection operation")

    async def _session(
        self, dao: ConversationDao, owner: str, connector: str, params: dict[str, object]
    ) -> SessionRow:
        value = {**params, **record(params.get("session"))}
        identifier = str(value.get("sessionId", value.get("id", "")))
        if not identifier or len(identifier) > 100:
            raise DomainError(422, "notification requires session identity")
        await dao.lock(identifier)
        row = await dao.session(identifier)
        if row and (row.owner_id != owner or row.connector_id != connector):
            raise DomainError(403, "foreign session notification")
        if row and (
            value.get("runtimeId", row.runtime_id) != row.runtime_id
            or value.get("runtime", row.runtime_type) != row.runtime_type
        ):
            raise DomainError(409, "session runtime binding mismatch")
        if not row:
            now = datetime.now(UTC)
            row = SessionRow(
                id=identifier,
                owner_id=owner,
                connector_id=connector,
                runtime_id=str(value.get("runtimeId", "dsh")),
                runtime_type=str(value.get("runtime", "dsh")),
                title=str(value.get("title", "新会话"))[:500],
                cwd=str(value.get("cwd", "")),
                status="idle",
                archived=False,
                pinned=False,
                takeover=False,
                sequence=0,
                last_read_seq=0,
                latest_turn_end_seq=0,
                state={},
                source={},
                created_at=now,
                updated_at=now,
                sort_at=now,
            )
            await dao.save(row)
        if row.source.get("historyDeletedAt"):
            return row
        external = value.get("externalSessionId")
        if isinstance(external, str):
            row.external_session_id = external
        display = {
            key: value[key]
            for key in ("runtimeName", "runtimeTypeDisplayName")
            if isinstance(value.get(key), str)
        }
        if display:
            row.source = {**row.source, **display}
        return row

    async def _notification(
        self,
        dao: ConversationDao,
        owner: str,
        connector: str,
        method: str,
        params: dict[str, object],
    ) -> None:
        # 原生投影流同时携带运行级目录和初始库存控制消息；它们已经由 RuntimeBatch
        # 持久保存，目录通过 runtime/catalogs 读取，不应被当成无身份的会话通知。
        # 仅对明确的非会话方法放行；带会话身份的能力/目录变更继续授权和投影。
        if method == "runtime.error":
            method, params = "notice.upsert", runtime_error_notice(params)
        if method in {
            "session.inventory.begin",
            "session.inventory.complete",
            "workspace.inventory",
            "catalog.model.update",
            "catalog.permission.update",
            "protocol.capabilitiesUpdated",
            "runtime.catalog.updated",
            "runtime.capability.updated",
        } and not (
            params.get("sessionId")
            or record(params.get("session")).get("id")
            or record(params.get("session")).get("sessionId")
        ):
            return
        supported = {
            "session.created",
            "session.updated",
            "session.upsert",
            "session.meta.upsert",
            "session.state.updated",
            "session.source.updated",
            "session.turnEnded",
            "session.capability.updated",
            "timeline.itemUpsert",
            "timeline.sync",
            "notice.upsert",
            "runtime.capability.updated",
            "runtime.catalog.updated",
        }
        if method not in supported:
            # 旧接缝允许未来通知前向兼容；已废弃且会绕过现协议的旧通知仍明确拒绝。
            if method in {
                "approval.requested",
                "protocol.modelCatalogUpdated",
                "protocol.permissionCatalogUpdated",
            }:
                raise DomainError(422, f"unsupported notification: {method}")
            return
        row = await self._session(dao, owner, connector, params)
        # 用户删除的平台历史不能被迟到通知、完整快照或引擎重启重新填回。
        if row.source.get("historyDeletedAt"):
            return
        if method in {"timeline.itemUpsert", "timeline.sync"}:
            before_sequence = row.sequence
            values = (
                [params.get("item")] if method == "timeline.itemUpsert" else params.get("items")
            )
            if not isinstance(values, list) or len(values) > 100000:
                raise DomainError(422, "invalid timeline items")
            retained: list[str] = []
            # 与旧投影入口一致，失败提示也是可恢复事件；完整同步不能把它误删。
            prepared = runtime_failure_items([record(value) for value in values])
            for item in prepared:
                identifier = item.get("id")
                if (
                    not isinstance(identifier, str)
                    or not identifier
                    or len(identifier) > 200
                    or item.get("sessionId", row.id) != row.id
                ):
                    raise DomainError(422, "invalid timeline identity")
                retained.append(identifier)
            if method == "timeline.sync" and params.get("complete") is True:
                deleted = await dao.replace_items(row.id, retained)
                if deleted:
                    await self.emit(
                        dao,
                        row,
                        "session.refetch_required",
                        {"eventCursor": f"seq:{row.sequence + 1}"},
                    )
            for item in prepared:
                identifier = str(item["id"])
                previous = await dao.item(row.id, identifier)
                if previous and previous.payload == item:
                    continue
                revision = item.get("revision", 1)
                if (
                    previous
                    and isinstance(revision, int)
                    and isinstance(previous.payload.get("revision"), int)
                    and revision < int(str(previous.payload["revision"]))
                ):
                    continue
                order = (
                    previous.order_seq
                    if previous
                    else item.get("orderSeq", item.get("seq", row.sequence + 1))
                )
                if not isinstance(order, int):
                    raise DomainError(422, "invalid timeline order")
                await self.emit(
                    dao,
                    row,
                    "timeline.item_updated" if previous else "timeline.item_created",
                    {"item": item},
                )
                entry = previous or TimelineRow(
                    session_id=row.id,
                    item_id=identifier,
                    sequence=row.sequence,
                    order_seq=order,
                    payload=item,
                )
                entry.sequence, entry.order_seq, entry.payload = row.sequence, order, item
                entry.item_time = item_timestamp(item.get("createdAt"), row.updated_at)
                await dao.save(entry)
                row.last_activity_at = row.updated_at
                row.sort_at = row.updated_at
            if method == "timeline.sync":
                row.source = {**row.source, "lastSyncedAt": datetime.now(UTC).isoformat()}
                if isinstance(params.get("sourceObservedAt"), str):
                    row.source = {**row.source, "observedAt": params["sourceObservedAt"]}
                if row.sequence > before_sequence:
                    # 与旧完整/增量同步一致，导入历史已读游标覆盖本轮实际同步事实。
                    row.last_read_seq = row.sequence
            latest = await dao.latest_item(row.id)
            row.last_item_at = latest.item_time if latest else None
            row.last_item_order_seq = latest.order_seq if latest else None
        elif method == "session.state.updated":
            incoming_status = str(params.get("status", row.status))[:30]
            # 固定 DSH 先提交 turnEnded，再发送当前调度状态；同轮失败后的 idle
            # 仅表示队列空闲，不能把失败改成成功。新轮 starting/running 会解除此保护。
            status = (
                "error" if incoming_status == "idle" and row.status == "error" else incoming_status
            )
            state = {**row.state, **params, "sessionId": row.id, "status": status}
            if incoming_status in {"starting", "running"}:
                state.update({"error": None, "statusReason": None})
            elif status == "error" and incoming_status == "idle":
                for key in ("error", "statusReason"):
                    if key in row.state:
                        state[key] = row.state[key]
            row.status = status
            if state != row.state:
                row.state = state
                await self.emit(dao, row, "runtime.state.updated", {"state": state})
        elif method == "session.turnEnded":
            row.status = "error" if params.get("outcome") == "failed" else "idle"
            row.state = {**row.state, "sessionId": row.id, "status": row.status}
            if row.status == "idle":
                row.state.update({"error": None, "statusReason": None})
            await self.emit(dao, row, "session.turn_ended", params)
            row.latest_turn_end_seq = row.sequence
        elif method == "session.source.updated":
            source = record(params.get("sourceState"))
            availability = params.get(
                "availability",
                params.get("sourceState")
                if isinstance(params.get("sourceState"), str)
                else source.get("availability", "available"),
            )
            if not isinstance(availability, str) or availability not in {
                "available",
                "archived",
                "unavailable",
                "deleted",
                "missing",
                "unknown",
            }:
                raise DomainError(422, "invalid source state")
            reason = params.get("reason", source.get("reason"))
            now = datetime.now(UTC).isoformat()
            changed = (
                row.source.get("availability") != availability or row.source.get("reason") != reason
            )
            if availability == "archived" and row.source.get("availability") in {
                None,
                "visible",
                "available",
            }:
                row.archived = True
                row.archived_at = datetime.now(UTC)
            row.source = {
                **row.source,
                "availability": availability,
                "reason": reason,
                "observedAt": params.get("observedAt", source.get("observedAt", now)),
                "observationOrigin": params.get("observationOrigin", "notification"),
                "availabilityUpdatedAt": now
                if changed
                else row.source.get("availabilityUpdatedAt"),
            }
            await self.emit(dao, row, "session.meta.updated", {})
        elif method == "notice.upsert":
            raw_notices = row.state.get("notices")
            notices = list(raw_notices) if isinstance(raw_notices, list) else []
            notice = notice_view(record(params.get("notice", params)))
            notices = [item for item in notices if record(item).get("id") != notice.get("id")]
            row.state = {**row.state, "notices": [*notices, notice][-100:]}
            await self.emit(dao, row, "runtime.notice.updated", {"notice": notice})
        elif method in {"session.capability.updated", "runtime.capability.updated"}:
            row.state = {**row.state, "capabilitySet": params.get("capabilitySet", params)}
            await self.emit(dao, row, "runtime.capability.updated", params)
        elif method == "runtime.catalog.updated":
            kind = params.get("catalogType")
            catalog = params.get("catalog")
            if kind not in {"model", "permission"} or not isinstance(catalog, dict):
                raise DomainError(422, "invalid session catalog")
            row.state = {
                **row.state,
                "catalogs": {**record(row.state.get("catalogs")), str(kind): catalog},
            }
            await self.emit(dao, row, "runtime.catalog.updated", params)
        else:
            title = params.get("title", record(params.get("session")).get("title"))
            if isinstance(title, str) and title.strip():
                row.title = title[:500]
            row.source = {**row.source, "lastSyncedAt": datetime.now(UTC).isoformat()}
            await self.emit(dao, row, "session.meta.updated", {})
        await dao.save(row)
