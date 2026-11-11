"""回放真实 DSH 初始批次的脱敏结构，防止运行级通知卡住会话快照游标。"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from app.infrastructure.errors import DomainError
from app.modules.conversations.dao.conversation_dao import (
    ConversationDao,
    ConversationRepository,
)
from app.modules.conversations.entity.do.models import (
    ConversationEventRow,
    ProjectionCursorRow,
    SessionRow,
    TimelineRow,
)
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.conversations.service.projection_service import ProjectionService
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account


def projection() -> tuple[ProjectionService, Mock, AsyncMock, list[object]]:
    """注入有限持久存储，执行真实 sync 和通知分流，不替换被测方法。"""
    stored: list[object] = []
    dao = AsyncMock(spec=ConversationDao)
    dao.cursor.side_effect = lambda _: next(
        (value for value in reversed(stored) if isinstance(value, ProjectionCursorRow)),
        None,
    )
    dao.session.side_effect = lambda identifier: next(
        (value for value in stored if isinstance(value, SessionRow) and value.id == identifier),
        None,
    )
    dao.item.side_effect = lambda session, identifier: next(
        (
            value
            for value in stored
            if isinstance(value, TimelineRow)
            and value.session_id == session
            and value.item_id == identifier
        ),
        None,
    )
    dao.latest_item.side_effect = lambda session: max(
        (
            value
            for value in stored
            if isinstance(value, TimelineRow) and value.session_id == session
        ),
        key=lambda item: (item.item_time, item.order_seq),
        default=None,
    )

    async def replace_items(session: str, retained: list[str]) -> bool:
        count = len(stored)
        stored[:] = [
            value
            for value in stored
            if not isinstance(value, TimelineRow)
            or value.session_id != session
            or value.item_id in retained
        ]
        return len(stored) != count

    dao.replace_items.side_effect = replace_items

    async def save(value: object) -> None:
        if value not in stored:
            stored.append(value)

    dao.save.side_effect = save
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    repository = Mock(spec=ConversationRepository)
    repository.transaction.return_value = transaction
    devices = Mock(spec=DeviceService)
    devices.connection_online = AsyncMock(return_value=False)
    devices.native_ids.return_value = ("synthetic-connector", "synthetic-project")
    runtime = Mock()
    runtime.events = AsyncMock()
    devices.runtime_getter = Mock(return_value=runtime)
    return ProjectionService(repository, devices), runtime, dao, stored


@pytest.mark.parametrize(
    "method, payload",
    [
        ("session.meta.upsert", {"title": "迟到的标题"}),
        ("session.state.updated", {"status": "running"}),
        (
            "timeline.sync",
            {"items": [{"id": "late", "type": "message"}], "complete": True},
        ),
        ("notice.upsert", {"noticeId": "late", "message": "迟到提示"}),
    ],
)
async def test_deleted_history_is_not_restored_by_late_projection(
    method: str, payload: dict[str, object]
) -> None:
    """删除墓碑跨投影实例保存；迟到事件和完整快照都不能重建历史内容。"""
    service, _, dao, stored = projection()
    row = SessionRow(
        id="synthetic-deleted",
        owner_id="synthetic-owner",
        connector_id="synthetic-connector",
        runtime_id="dsh",
        runtime_type="dsh",
        source={"historyDeletedAt": "synthetic"},
        state={},
        title="已删除会话",
        sequence=10,
    )
    stored.append(row)
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        method,
        {**payload, "sessionId": row.id},
    )
    assert stored == [row] and row.sequence == 10 and row.title == "已删除会话"
    assert row.state == {} and row.source["historyDeletedAt"] == "synthetic"
    dao.save.assert_not_awaited()


@pytest.mark.parametrize("method", ["notice.upsert", "runtime.error"])
async def test_notices_keep_legacy_event_type_and_persist_recovery_state(
    method: str,
) -> None:
    """通知与运行错误都产出旧客户端识别的事件名，恢复快照保留同一通知身份。"""
    service, _, _, stored = projection()
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        method,
        {
            "sessionId": "synthetic-session",
            "runtime": "dsh",
            "noticeId": "notice-one",
            "message": "合成提示",
        },
    )
    event = next(value for value in stored if isinstance(value, ConversationEventRow))
    row = next(value for value in stored if isinstance(value, SessionRow))
    assert event.type == "runtime.notice.updated"
    notice, notices = event.payload["notice"], row.state["notices"]
    assert isinstance(notice, dict) and isinstance(notices, list)
    assert notice == notices[0]
    assert notice["noticeId"] == "notice-one"


async def test_real_startup_batches_advance_without_fabricating_sessions() -> None:
    """保留真实三批结构，仅替换身份/模型信息；再次读取不会重放或制造假会话。"""
    batches = json.loads(
        (Path(__file__).parents[1] / "fixtures/runtime/startup-batches.json").read_text("utf-8")
    )
    service, runtime, dao, stored = projection()
    runtime.events.return_value = [
        {"cursor": index, "batch": batch} for index, batch in enumerate(batches, 1)
    ]
    account = Account("synthetic-owner", "synthetic", (), ("sessions.run",), 1)
    await service.sync(account)
    cursor = next(value for value in stored if isinstance(value, ProjectionCursorRow))
    assert cursor.cursor == 3
    assert not any(
        isinstance(value, (SessionRow, ConversationEventRow, TimelineRow)) for value in stored
    )
    dao.session.assert_not_awaited()
    dao.save.reset_mock()
    await service.sync(account)
    runtime.events.assert_awaited_with("synthetic-owner", 3)
    dao.save.assert_not_awaited()


@pytest.mark.parametrize(
    "method",
    [
        "approval.requested",
        "protocol.permissionCatalogUpdated",
        "protocol.modelCatalogUpdated",
    ],
)
async def test_unknown_notifications_remain_explicit_errors(method: str) -> None:
    """已废弃的审批和模型通知不能绕过正式协议，保持旧处理器明确拒绝。"""
    service, _, dao, _ = projection()
    with pytest.raises(DomainError, match="unsupported"):
        await service.ingest(
            "synthetic-owner",
            "synthetic-connector",
            method,
            {"sessionId": "synthetic-session"},
        )
    dao.session.assert_not_awaited()


@pytest.mark.parametrize("method", ["session.unknown", "catalog.model.unknown"])
async def test_future_notifications_are_ignored_without_persistence(
    method: str,
) -> None:
    """与旧 Hub 相同，未来未知通知不产生会话事实，也不会断开合法设备。"""
    service, _, dao, _ = projection()
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        method,
        {"sessionId": "synthetic-session"},
    )
    dao.session.assert_not_awaited()
    dao.save.assert_not_awaited()


async def test_source_observation_and_sync_metadata_are_preserved() -> None:
    """源观测与同步时间各自保存，不能用每次读取的当前时间冒充已观察事实。"""
    from app.modules.conversations.service.views import session_view

    service, _, _, stored = projection()
    identity: dict[str, object] = {
        "sessionId": "synthetic-source",
        "runtime": "dsh",
        "runtimeId": "dsh",
        "runtimeName": "测试运行",
        "runtimeTypeDisplayName": "DSH测试",
    }
    await service.ingest("synthetic-owner", "synthetic-connector", "session.meta.upsert", identity)
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.source.updated",
        {
            **identity,
            "availability": "archived",
            "reason": "source archived",
            "observedAt": "2025-01-02T03:04:05Z",
            "observationOrigin": "inventory",
        },
    )
    row = next(item for item in stored if isinstance(item, SessionRow))
    view = session_view(row)
    assert view["runtimeTypeDisplayName"] == "DSH测试"
    assert view["runtimeName"] == "测试运行"
    assert view["sourceObservedAt"] == "2025-01-02T03:04:05Z"
    assert view["sourceObservationOrigin"] == "inventory"
    assert view["sourceAvailabilityUpdatedAt"] and view["lastSyncedAt"]
    assert view["archived"] is True and view["archiveSource"] == "both"
    assert session_view(row) == view


async def test_message_activity_is_independent_of_metadata_and_old_item_replay() -> None:
    """收到迟到旧消息仍更新平台活动，但最后消息时间按真实时间排序；元数据不制造消息。"""
    from app.modules.conversations.service.views import session_view

    service, _, _, stored = projection()
    identity: dict[str, object] = {
        "sessionId": "synthetic-activity",
        "runtime": "dsh",
        "runtimeId": "dsh",
    }
    await service.ingest("synthetic-owner", "synthetic-connector", "session.created", identity)
    row = next(value for value in stored if isinstance(value, SessionRow))
    before = session_view(row)
    assert before["lastActivityAt"] is before["lastItemAt"] is before["lastItemOrderSeq"] is None
    assert before["runtimeName"] is before["cwd"] is None
    latest: dict[str, object] = {
        "id": "latest",
        "type": "message",
        "orderSeq": 10,
        "createdAt": "2025-02-03T04:05:06Z",
    }
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "timeline.itemUpsert",
        {**identity, "item": latest},
    )
    active = session_view(row)
    assert active["lastItemAt"] == "2025-02-03T04:05:06+00:00"
    assert active["lastItemOrderSeq"] == 10 and active["lastActivityAt"]
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.updated",
        {**identity, "title": "修改标题"},
    )
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.state.updated",
        {**identity, "status": "idle"},
    )
    for key in ("lastActivityAt", "lastItemAt", "lastItemOrderSeq", "sortAt"):
        assert session_view(row)[key] == active[key]
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "timeline.itemUpsert",
        {**identity, "item": latest},
    )
    assert session_view(row)["lastActivityAt"] == active["lastActivityAt"]
    historical = {
        **latest,
        "id": "historical",
        "orderSeq": 20,
        "createdAt": "2024-01-01T00:00:00Z",
    }
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "timeline.itemUpsert",
        {**identity, "item": historical},
    )
    assert row.last_item_order_seq == 10
    assert row.last_item_at == datetime(2025, 2, 3, 4, 5, 6, tzinfo=UTC)
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "timeline.sync",
        {**identity, "items": [historical], "complete": True},
    )
    assert row.last_item_order_seq == 20
    assert row.last_item_at == datetime(2024, 1, 1, tzinfo=UTC)
    reset = [
        value
        for value in stored
        if isinstance(value, ConversationEventRow) and value.type == "session.refetch_required"
    ]
    assert len(reset) == 1
    assert reset[0].payload == {"eventCursor": f"seq:{reset[0].sequence}"}
    sequence = row.sequence
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "timeline.sync",
        {**identity, "items": [historical], "complete": True},
    )
    assert row.sequence == sequence


@pytest.mark.parametrize(
    "method",
    [
        "catalog.model.update",
        "catalog.permission.update",
        "session.inventory.begin",
        "session.inventory.complete",
    ],
)
async def test_control_methods_are_ignored_like_the_legacy_hub(method: str) -> None:
    """旧接缝忽略非投影控制消息；携带额外会话字段也不得新增协议错误。"""
    service, _, _, stored = projection()
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        method,
        {"sessionId": "synthetic-session"},
    )
    assert stored == []


@pytest.mark.parametrize(
    "method",
    [
        "approval.requested",
        "protocol.modelCatalogUpdated",
        "protocol.permissionCatalogUpdated",
    ],
)
async def test_only_the_three_legacy_retired_notifications_are_rejected(
    method: str,
) -> None:
    """废弃通知名单与旧 Hub 完全相同，错误包含实际方法名。"""
    service, _, _, stored = projection()
    with pytest.raises(DomainError, match=f"unsupported notification: {method}"):
        await service.ingest("synthetic-owner", "synthetic-connector", method, {})
    assert stored == []


@pytest.mark.parametrize("method", ["runtime.capability.updated", "runtime.catalog.updated"])
async def test_session_scoped_updates_keep_ownership_checks(method: str) -> None:
    """同名运行级通知带 sessionId 时必须核验归属，不能套用无会话分流。"""
    service, _, _, stored = projection()
    stored.append(
        SessionRow(id="foreign", owner_id="another-owner", connector_id="synthetic-connector")
    )
    with pytest.raises(DomainError, match="foreign"):
        await service.ingest(
            "synthetic-owner", "synthetic-connector", method, {"sessionId": "foreign"}
        )


async def test_session_scoped_capabilities_and_catalog_are_projected() -> None:
    """会话能力和目录进入自己的快照，并保留客户端事件语义。"""
    service, _, _, stored = projection()
    capabilities = {
        "revision": 4,
        "capabilities": [{"capabilityId": "session.send_message", "allowed": True}],
    }
    catalog = {
        "revision": 5,
        "models": [{"selectionId": "synthetic-model-selection", "enabled": True}],
    }
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "runtime.capability.updated",
        {"sessionId": "synthetic-session", "capabilitySet": capabilities},
    )
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "runtime.catalog.updated",
        {"sessionId": "synthetic-session", "catalogType": "model", "catalog": catalog},
    )
    session = next(value for value in stored if isinstance(value, SessionRow))
    assert session.state["capabilitySet"] == capabilities
    assert session.state["catalogs"] == {"model": catalog}
    assert [value.type for value in stored if isinstance(value, ConversationEventRow)] == [
        "runtime.capability.updated",
        "runtime.catalog.updated",
    ]


async def test_invalid_session_catalog_fails_explicitly() -> None:
    service, _, _, _ = projection()
    with pytest.raises(DomainError, match="invalid session catalog"):
        await service.ingest(
            "synthetic-owner",
            "synthetic-connector",
            "runtime.catalog.updated",
            {"sessionId": "synthetic-session", "catalogType": "unknown", "catalog": {}},
        )


async def test_native_assistant_message_and_turn_completion_keep_original_shape() -> None:
    """真实 bridge 使用 content.text 与平铺 selections，回放不能丢模型来源或正文。"""
    service, _, _, stored = projection()
    identity = {
        "sessionId": "synthetic-session",
        "externalSessionId": "synthetic-native",
    }
    selections = {
        "model": "synthetic-model-selection",
        "permission": "synthetic-read-only",
    }
    item = {
        "id": "synthetic-assistant-message",
        **identity,
        "type": "message",
        "status": "done",
        "role": "assistant",
        "turnId": "synthetic-turn",
        "orderSeq": 2,
        "revision": 4,
        "contentHash": "synthetic-hash",
        "content": {"kind": "markdown", "format": "markdown", "text": "OK"},
        "source": {
            "runtime": "dsh",
            "sessionId": "synthetic-native",
            "itemId": "synthetic-item",
            "itemType": "assistant/message",
            "seq": 3,
            "lastSeq": 3,
            "time": 1,
            "provider": "synthetic-provider",
            "model": "synthetic-model",
        },
    }
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.state.updated",
        {**identity, "status": "running", "selections": selections},
    )
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "timeline.itemUpsert",
        {**identity, "item": item},
    )
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.turnEnded",
        {**identity, "outcome": "completed"},
    )
    session = next(value for value in stored if isinstance(value, SessionRow))
    message = next(value for value in stored if isinstance(value, TimelineRow))
    assert session.status == session.state["status"] == "idle"
    assert session.state["selections"] == selections
    assert session.external_session_id == "synthetic-native"
    assert message.payload == item
    assert session.latest_turn_end_seq == session.sequence


@pytest.mark.parametrize("new_status", ["starting", "running"])
async def test_failed_turn_idle_does_not_hide_failure_and_new_turn_can_recover(
    new_status: str,
) -> None:
    """严格复现固定 bridge 的 turnEnded→state 顺序，保护失败但不永久粘住 error。"""
    service, _, _, stored = projection()
    identity = {
        "sessionId": "synthetic-session",
        "externalSessionId": "synthetic-native",
    }
    failure = {"code": "synthetic_failure", "message": "合成失败"}
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.state.updated",
        {**identity, "status": "error", "error": failure, "statusReason": "合成失败"},
    )
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.turnEnded",
        {**identity, "outcome": "failed"},
    )
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.state.updated",
        {**identity, "status": "idle", "error": None, "statusReason": None},
    )
    session = next(value for value in stored if isinstance(value, SessionRow))
    assert session.status == session.state["status"] == "error"
    assert session.state["error"] == failure
    assert session.state["statusReason"] == "合成失败"
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.state.updated",
        {**identity, "status": new_status},
    )
    assert session.status == session.state["status"] == new_status
    assert session.state["error"] is None
    assert session.state["statusReason"] is None
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.turnEnded",
        {**identity, "outcome": "completed"},
    )
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.state.updated",
        {**identity, "status": "idle"},
    )
    assert session.status == session.state["status"] == "idle"


@pytest.mark.parametrize(
    "outcome,expected",
    [("failed", "error"), ("completed", "idle"), ("interrupted", "idle")],
)
async def test_turn_end_synchronizes_both_persistent_status_views(
    outcome: str, expected: str
) -> None:
    service, _, _, stored = projection()
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.state.updated",
        {"sessionId": "synthetic-session", "status": "running"},
    )
    await service.ingest(
        "synthetic-owner",
        "synthetic-connector",
        "session.turnEnded",
        {"sessionId": "synthetic-session", "outcome": outcome},
    )
    session = next(value for value in stored if isinstance(value, SessionRow))
    assert session.status == session.state["status"] == expected


async def test_snapshot_and_state_endpoint_keep_authoritative_identity_and_status() -> None:
    """历史扩展状态即使带旧身份/idle，也不能覆盖会话行的新状态。"""
    session = SessionRow(
        id="synthetic-session",
        runtime_type="dsh",
        runtime_id="synthetic-runtime",
        external_session_id="synthetic-native",
        created_at=datetime(2025, 1, 1, tzinfo=UTC),
        updated_at=datetime(2025, 2, 1, tzinfo=UTC),
        status="error",
        sequence=0,
        state={
            "sessionId": "stale-session",
            "status": "idle",
            "selections": {"model": "synthetic-model"},
        },
    )
    conversations = Mock(spec=ConversationService)
    conversations.projection = Mock(sync=AsyncMock())
    conversations.own = AsyncMock(return_value=session)
    conversations.view = AsyncMock(return_value={"id": session.id, "status": session.status})
    conversations.timeline = AsyncMock(return_value={"items": [], "nextSeq": 0, "hasMore": False})
    conversations.runtime_capabilities = AsyncMock(return_value={})
    account = Account("synthetic-owner", "synthetic", (), ("sessions.read",), 1)
    snapshot = await ConversationService.snapshot(conversations, account, session.id)
    state = await ConversationService.runtime_state(conversations, account, session.id)
    assert (
        snapshot["state"]
        == state["state"]
        == {
            "sessionId": "synthetic-session",
            "runtime": "dsh",
            "runtimeId": "synthetic-runtime",
            "runtimeType": "dsh",
            "externalSessionId": "synthetic-native",
            "status": "error",
            "selections": {"model": "synthetic-model"},
            "statusReason": None,
            "error": None,
            "metadata": {},
            "updatedSeq": 0,
            "createdAt": "2025-01-01T00:00:00+00:00",
            "updatedAt": "2025-02-01T00:00:00+00:00",
        }
    )
