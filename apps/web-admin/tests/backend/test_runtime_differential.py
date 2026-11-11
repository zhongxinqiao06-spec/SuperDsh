"""同一输入执行旧真实处理器与新服务，验证运行边界而非复制预期实现。"""

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from types import MethodType
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest

from app.infrastructure.errors import DomainError
from app.modules.conversations.dao.conversation_dao import ConversationDao
from app.modules.conversations.entity.do.models import (
    ConversationEventRow,
    ConversationShareRow,
    SessionRow,
    TimelineRow,
)
from app.modules.conversations.entity.vo.conversation_dto import CreateSessionInput
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.conversations.service.execution_service import ExecutionService
from app.modules.conversations.service.interaction_protocol import runtime_error_notice
from app.modules.conversations.service.projection_service import ProjectionService
from app.modules.conversations.service.runtime_failure import runtime_failure_items
from app.modules.conversations.service.share_service import ShareService
from app.modules.conversations.service.views import effective_capabilities, session_view
from app.modules.devices.dao.device_dao import DeviceDao
from app.modules.devices.entity.do.models import DeviceRow
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account
from app.modules.skills.service.matching import match_skills

ROOT = Path(__file__).resolve().parents[4]
ACCOUNT = Account("synthetic-owner", "synthetic", (), ("sessions.run", "sessions.read"), 1)


def oracle(inputs: list[dict[str, object]]) -> list[object]:
    """Node 仅加载旧源码，读写边界全部由测试注入，禁止真实连接和模型调用。"""
    process = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/runtime-oracle.ts")],
        input=json.dumps(inputs),
        text=True,
        encoding="utf-8",
        capture_output=True,
        cwd=ROOT,
        timeout=30,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    return cast(list[object], json.loads(process.stdout))


def conversation(takeover: bool, archived: bool = False) -> tuple[Mock, SessionRow]:
    now = datetime.now(UTC)
    row = SessionRow(
        id="synthetic-session",
        owner_id=ACCOUNT.user_id,
        connector_id="synthetic-connector",
        runtime_id="dsh",
        runtime_type="dsh",
        takeover=takeover,
        archived=archived,
        source={},
        status="idle",
        state={},
        sequence=0,
        title="测试会话",
        cwd="synthetic-workspace",
        last_read_seq=0,
        latest_turn_end_seq=0,
        agent_binding=None,
        external_session_id="synthetic-native",
        created_at=now,
        updated_at=now,
    )
    service = Mock(spec=ConversationService)
    service.own = AsyncMock(return_value=row)
    service.devices = Mock()
    service.devices.own = AsyncMock(return_value=Mock(executor_kind="desktop"))
    service.devices.view.return_value = {"status": "online"}
    service.projection = Mock()
    service.projection.ingest = AsyncMock()
    service.projection.sync = AsyncMock()
    service.projection.emit = AsyncMock()
    service.binding_version = ConversationService.binding_version
    return service, row


async def test_native_device_is_registered_once_by_prepare_not_listing() -> None:
    """未准备时不凭空插入设备；登记后的轮询时间戳稳定，停止 Host 仍保留身份。"""
    account = Account("synthetic-owner", "synthetic", (), ("sessions.run", "devices.read"), 1)
    devices = DeviceService.__new__(DeviceService)
    identity = Mock()
    identity.get_account = AsyncMock(return_value=account)
    devices.identity = identity
    devices.runtime_getter = lambda: None
    devices.channel = Mock(connections={})
    stored: list[DeviceRow] = []
    dao = AsyncMock(spec=DeviceDao)
    dao.devices.side_effect = lambda *_: list(stored)
    dao.device.side_effect = lambda identifier: next(
        (row for row in stored if row.id == identifier), None
    )
    dao.save.side_effect = stored.append
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    repository = Mock()
    repository.transaction.return_value = transaction
    devices.repository = repository
    assert (await devices.listing(account))["connectors"] == []
    dao.save.assert_not_awaited()
    await devices.ensure_native(account.user_id)
    first = (await devices.listing(account))["connectors"]
    await devices.ensure_native(account.user_id)
    assert (await devices.listing(account))["connectors"] == first
    assert dao.save.await_count == 1


@pytest.mark.parametrize("with_activity", [False, True])
def test_session_activity_view_matches_actual_legacy_projection(with_activity: bool) -> None:
    """同一持久事实送进旧新视图，空会话、消息活动和管理修改必须分开。"""
    _, row = conversation(True)
    row.cwd = ""
    timestamp = datetime(2025, 2, 3, 4, 5, 6, tzinfo=UTC)
    row.created_at = timestamp
    row.updated_at = datetime(2026, 3, 4, tzinfo=UTC)
    row.sort_at = timestamp
    row.last_activity_at = timestamp if with_activity else None
    row.last_item_at = timestamp if with_activity else None
    row.last_item_order_seq = 12 if with_activity else None
    stamp = timestamp.isoformat()
    prior = oracle(
        [
            {
                "kind": "session-view",
                "row": {
                    "id": row.id,
                    "runtime": "dsh",
                    "connector_id": row.connector_id,
                    "updated_at": row.updated_at.isoformat(),
                    "sort_at": stamp,
                    "last_activity_at": stamp if with_activity else None,
                    "last_item_at": stamp if with_activity else None,
                    "last_item_order_seq": row.last_item_order_seq,
                    "updated_seq": 0,
                },
            }
        ]
    )[0]
    assert isinstance(prior, dict)
    current = session_view(row)
    for key in (
        "lastActivityAt",
        "lastItemAt",
        "lastItemOrderSeq",
        "sortAt",
        "runtimeName",
        "cwd",
        "pinnedAt",
        "archivedAt",
    ):
        assert current[key] == prior[key], key


@pytest.mark.parametrize(
    "version,status,pending,expected",
    [
        (1, "idle", False, 200),
        (0, "idle", False, 409),
        (1, "running", False, 409),
        (1, "idle", True, 409),
        (None, "idle", False, 422),
        (True, "idle", False, 422),
    ],
)
async def test_existing_agent_binding_switch_requires_idle_and_current_revision(
    version: object, status: str, pending: bool, expected: int
) -> None:
    service, row = conversation(True)
    row.agent_binding = {
        "definition": {"id": "old-agent"},
        "bindingVersion": 1,
        "bindingId": "old-frozen-resource",
    }
    service.devices.own = AsyncMock(return_value=Mock(executor_kind="server-agent"))
    service.devices.call = AsyncMock(return_value={"sessionId": row.id, "status": status})
    service.agent_resolver = AsyncMock(
        return_value={
            "definition": {
                "id": "new-agent",
                "name": "新智能体",
                "version": 7,
            }
        }
    )
    service.binding_guard = AsyncMock(side_effect=DomainError(409, "pending") if pending else None)
    dao = AsyncMock(spec=ConversationDao)
    dao.session.return_value = row
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    service.repository = Mock()
    service.repository.transaction.return_value = transaction
    service.binding = MethodType(ConversationService.binding, service)
    service.binding_view = MethodType(ConversationService.binding_view, service)
    actual = 200
    try:
        result = await ConversationService.bind_agent(
            service, ACCOUNT, row.id, "new-agent", version
        )
        assert result == {
            "agentDefinition": {"id": "new-agent", "name": "新智能体", "version": 7},
            "bindingVersion": 2,
        }
        assert "bindingId" not in row.agent_binding
    except DomainError as error:
        actual = error.status
    assert actual == expected


@pytest.mark.parametrize(
    "takeover,archived,available",
    [
        (False, False, True),
        (True, False, True),
        (True, True, True),
        (True, False, False),
    ],
)
async def test_old_new_interrupt_authorization(
    takeover: bool, archived: bool, available: bool
) -> None:
    capability = {
        "capabilityId": "session.interrupt",
        "supported": True,
        "available": available,
        "allowed": True,
    }
    expected = oracle(
        [
            {
                "kind": "command",
                "takeover": takeover,
                "archived": archived,
                "capabilities": [capability],
            }
        ]
    )[0]
    service, row = conversation(takeover, archived)
    dispatched: list[str] = []

    async def call(_: Account, _connector: str, method: str, _params: object) -> object:
        dispatched.append(method)
        if method == "session.state":
            return {"state": {"sessionId": row.id, "status": "idle"}}
        if method == "session.capabilities":
            return {"capabilitySet": {"capabilities": [capability]}}
        return {"ok": True}

    service.devices.call = AsyncMock(side_effect=call)
    status = 200
    try:
        await ExecutionService(service).command(ACCOUNT, row.id, "interrupt", {})
    except DomainError as error:
        status = error.status
    assert {
        "status": status,
        "dispatched": "session.interrupt" in dispatched,
    } == expected


@pytest.mark.parametrize("online", [False, True])
async def test_metadata_notification_matches_legacy_hub_committed_session(online: bool) -> None:
    """实际旧 Hub 与新 emit 使用同输入，元数据帧必须有完整会话且序号一致。"""
    service, row = conversation(True)
    row.sequence = 6
    row.title = "更新前"
    prior = oracle(
        [
            {
                "kind": "metadata-notification",
                "online": online,
                "text": "更新后",
                "row": {
                    "id": row.id,
                    "connector_id": row.connector_id,
                    "runtime": row.runtime_type,
                    "title": row.title,
                    "seq": row.sequence,
                    "updated_seq": row.sequence,
                    "takeover": True,
                    "updated_at": row.updated_at.isoformat(),
                },
            }
        ]
    )[0]
    assert isinstance(prior, dict)
    dao = AsyncMock(spec=ConversationDao)
    dao.session.return_value = row
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    service.repository = Mock()
    service.repository.transaction.return_value = transaction
    service.devices.connection_online = AsyncMock(return_value=online)
    projection = ProjectionService(service.repository, service.devices)
    await projection.ingest(
        ACCOUNT.user_id,
        row.connector_id,
        "session.updated",
        {"sessionId": row.id, "title": "更新后", "updatedSeq": 999},
    )
    event = next(
        call.args[0]
        for call in dao.save.call_args_list
        if isinstance(call.args[0], ConversationEventRow)
    )
    assert set(event.payload) == {"session"}
    current = event.payload["session"]
    assert isinstance(current, dict)
    old_payload = prior["payload"]
    assert isinstance(old_payload, dict) and isinstance(old_payload["session"], dict)
    assert event.sequence == current["updatedSeq"] == prior["sequence"] == 7
    assert event.type == prior["type"] == "session.meta.updated"
    for key in (
        "id",
        "title",
        "connectorStatus",
        "takeover",
        "updatedSeq",
        "lastActivityAt",
        "lastItemAt",
    ):
        assert current[key] == old_payload["session"][key]
    service.devices.connection_online.assert_awaited_once_with(ACCOUNT.user_id, row.connector_id)


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {
            "title": "合成错误",
            "message": "设备执行失败",
            "operationId": "op-one",
            "noticeId": "error-one",
            "status": "closed",
        },
    ],
)
def test_runtime_error_notice_matches_actual_legacy_hub(extra: dict[str, object]) -> None:
    """旧 Hub 的 runtime.error 转换直接执行，默认信息及已有错误上下文都不能丢失。"""
    params = {"sessionId": "synthetic-session", "runtime": "dsh", **extra}
    prior = oracle([{"kind": "metadata-notification", "runtimeError": True, "params": params}])[0]
    assert prior == {"method": "notice.upsert", "params": runtime_error_notice(params)}


async def test_read_only_archived_session_can_synchronize() -> None:
    service, row = conversation(False, True)
    service.devices.call = AsyncMock(return_value={"ok": True})
    assert await ExecutionService(service).command(ACCOUNT, row.id, "sync", {}) == {"ok": True}
    cast(AsyncMock, service.projection.sync).assert_awaited_once_with(ACCOUNT)


@pytest.mark.parametrize("native", [True, False])
async def test_explicit_creation_is_writable_but_import_requires_takeover(
    native: bool,
) -> None:
    service, _ = conversation(False)
    dao = AsyncMock(spec=ConversationDao)
    dao.creation.return_value = None
    dao.session.return_value = None
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    service.repository = Mock()
    service.repository.transaction.return_value = transaction
    service.devices.own = AsyncMock(
        return_value=Mock(executor_kind="server-agent" if native else "desktop")
    )
    service.devices.workspace = Mock(return_value=Path("synthetic-workspace"))
    service.view = AsyncMock(return_value={})
    await ConversationService.create(
        service,
        ACCOUNT,
        CreateSessionInput(connectorId="synthetic-connector", clientMessageId="synthetic-create"),
        start=False,
    )
    assert cast(SessionRow, dao.save.call_args.args[0]).takeover is True
    projection = ProjectionService(service.repository, service.devices)
    imported = await projection._session(
        dao, ACCOUNT.user_id, "synthetic-connector", {"sessionId": "synthetic-imported"}
    )
    assert imported.takeover is False


def test_runtime_failure_differential_keeps_stable_redacted_notice() -> None:
    probes: list[dict[str, object]] = []
    cases: list[list[dict[str, object]]] = []
    for reason in [
        "response incomplete: length",
        "Response Incomplete: max_output_tokens",
        "synthetic-provider-failure-with-secret-not-for-display",
    ]:
        items: list[dict[str, object]] = [
            {
                "id": "turn-ending",
                "type": "turn.end",
                "orderSeq": 7,
                "content": {"reason": {"kind": "error", "error": {"message": reason}}},
            }
        ]
        probes.append({"kind": "failure", "items": items})
        cases.append(items)
    for items, expected in zip(cases, oracle(probes), strict=True):
        actual = runtime_failure_items(items)
        assert actual == expected
        assert runtime_failure_items(items) == actual
        assert "synthetic-provider-failure" not in json.dumps(actual[-1]["content"])


def test_skill_matching_old_new_exclusion_input_and_fixed_policy() -> None:
    skills: list[dict[str, object]] = [
        {
            "id": "synthetic-skill",
            "name": "示例技能",
            "description": "仅测试",
            "enabled": True,
            "program": {
                "match": {
                    "phrases": ["报告", "abc"],
                    "excludePhrases": ["禁止"],
                    "inputExtensions": [".csv"],
                    "outputTypes": ["csv"],
                    "examples": [],
                }
            },
        }
    ]
    probes: list[dict[str, object]] = [
        {
            "kind": "matching",
            "skills": skills,
            "text": text,
            "extensions": extensions,
            "fixedSkillId": fixed,
        }
        for text, extensions, fixed in [
            ("报告ＡＢＣ", [".csv"], None),
            ("禁止报告", [], None),
            ("报告", [".txt"], None),
            ("报告", [], "synthetic-skill"),
            ("报告", [], "missing-skill"),
        ]
    ]
    for probe, expected in zip(probes, oracle(probes), strict=True):
        assert (
            match_skills(
                skills,
                str(probe["text"]),
                cast(list[str], probe["extensions"]),
                cast(str | None, probe["fixedSkillId"]),
            )
            == expected
        )


def test_effective_capability_does_not_authorize_unclaimed_or_foreign_session() -> None:
    _, row = conversation(False)
    source: dict[str, object] = {
        "capabilities": [
            {"capabilityId": "session.interrupt", "supported": True, "available": True},
            {
                "capabilityId": "session.steer",
                "sessionId": "foreign",
                "supported": True,
            },
        ]
    }
    capabilities = cast(
        list[dict[str, object]],
        effective_capabilities(row, source, True)["capabilities"],
    )
    assert len(capabilities) == 1
    assert capabilities[0]["allowed"] is False
    assert capabilities[0]["unavailableReason"] == "session_not_taken_over"


@pytest.mark.parametrize(
    "scope,identifiers",
    [
        ("session", []),
        ("message", ["message-249"]),
        ("message", ["missing"]),
        ("message", ["message-1"]),
        ("message", ["message-249", "message-249"]),
        ("invalid", []),
    ],
)
async def test_share_snapshot_matches_old_full_history_and_reply_validation(
    scope: str, identifiers: list[str]
) -> None:
    items: list[dict[str, object]] = [
        {
            "id": f"message-{index}",
            "type": "message",
            "role": "assistant" if index > 1 else "user",
            "content": {"text": str(index), "fileId": f"synthetic-file-{index}"},
        }
        for index in range(250)
    ]
    expected = oracle([{"kind": "share", "items": items, "scope": scope, "itemIds": identifiers}])[
        0
    ]
    service, row = conversation(True)
    dao = AsyncMock(spec=ConversationDao)
    dao.snapshot_items.return_value = [TimelineRow(payload=item) for item in items]
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    service.repository = Mock()
    service.repository.transaction.return_value = transaction
    result: dict[str, object]
    try:
        await ShareService(service).create(
            ACCOUNT, row.id, {"scope": scope, "itemIds": identifiers}
        )
        saved = cast(ConversationShareRow, dao.save.call_args.args[0])
        timeline = cast(dict[str, object], saved.snapshot["timeline"])
        # 文件集合顺序不属于授权语义，旧按时间线首次出现排序，新按身份排序。
        result = {
            "status": 200,
            "items": timeline["items"],
            "fileIds": sorted(cast(list[str], saved.snapshot["fileIds"])),
        }
        assert isinstance(expected, dict)
        expected["fileIds"] = sorted(cast(list[str], expected["fileIds"]))
    except DomainError as error:
        result = {"status": error.status}
    assert result == expected
