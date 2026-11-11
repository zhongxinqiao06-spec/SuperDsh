"""会话生命周期失败与并发边界；外部引擎仅注入端口，不把替身当成真实中断证据。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest

from app.infrastructure.errors import DomainError
from app.integrations.dsh.protocol import RuntimeFailure
from app.modules.conversations.entity.do.models import SessionRow
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.conversations.service.lifecycle_service import SessionLifecycleService
from app.modules.identity.entity.bo.models import Account

OWNER = Account("synthetic-owner", "synthetic", ("member",), ("sessions.run", "sessions.read"), 1)


def fixture() -> tuple[SessionLifecycleService, SessionRow, Mock, SimpleNamespace]:
    """构造已授权记录，事务端口只服务于本用例状态断言。"""
    row = SessionRow(
        id="synthetic-session",
        owner_id=OWNER.user_id,
        source={},
        state={},
        status="idle",
        sequence=1,
    )
    dao = Mock(
        session=AsyncMock(return_value=row),
        lock=AsyncMock(),
        clear_history=AsyncMock(),
        save=AsyncMock(),
    )

    @asynccontextmanager
    async def transaction() -> AsyncIterator[Mock]:
        yield dao

    conversations = SimpleNamespace(
        repository=SimpleNamespace(transaction=transaction),
        own=AsyncMock(return_value=row),
        actions=SimpleNamespace(command=AsyncMock(return_value={"status": "idle"})),
        projection=SimpleNamespace(sync=AsyncMock(), emit=AsyncMock()),
    )
    return (
        SessionLifecycleService(cast(ConversationService, conversations)),
        row,
        dao,
        conversations,
    )


async def test_delete_history_preserves_identity_and_is_idempotent() -> None:
    service, row, dao, conversations = fixture()
    assert await service.remove(OWNER, row.id) == {"deleted": True}
    assert row.source["historyDeletedAt"] and row.takeover is False
    assert row.title == "已删除会话" and row.state == {} and row.id == "synthetic-session"
    assert await service.remove(OWNER, row.id) == {"deleted": True}
    dao.clear_history.assert_awaited_once_with(row.id)
    conversations.actions.command.assert_awaited_once()


@pytest.mark.parametrize("cause", ["foreign", "running", "disconnected", "concurrent"])
async def test_delete_rejects_unsafe_state(cause: str) -> None:
    service, row, dao, conversations = fixture()
    if cause == "foreign":
        row.owner_id = "another-owner"
    elif cause == "running":
        conversations.actions.command.return_value = {"status": "running"}
    elif cause == "disconnected":
        conversations.actions.command.side_effect = RuntimeFailure("runtime_not_ready", "synthetic")
    else:

        async def changed(*_args: object) -> dict[str, str]:
            row.status = "starting"
            return {"status": "idle"}

        conversations.actions.command.side_effect = changed
    with pytest.raises((DomainError, RuntimeFailure)):
        await service.remove(OWNER, row.id)
    dao.clear_history.assert_not_awaited()
    assert "historyDeletedAt" not in row.source


async def test_missing_native_session_can_be_removed() -> None:
    service, row, dao, conversations = fixture()
    row.status = "starting"
    conversations.actions.command.side_effect = RuntimeFailure("SESSION_NOT_FOUND", "synthetic")
    assert await service.remove(OWNER, row.id) == {"deleted": True}
    dao.clear_history.assert_awaited_once()


async def test_interrupt_missing_is_diagnostic_not_success() -> None:
    service, row, dao, conversations = fixture()
    row.status = "starting"
    conversations.actions.command.side_effect = RuntimeFailure("SESSION_NOT_FOUND", "synthetic")
    result = await service.interrupt(OWNER, row.id)
    assert result == {"accepted": False, "missing": True, "sessionId": row.id}
    assert row.status == "error" and row.state["statusReason"] == "session_source_missing"
    dao.clear_history.assert_not_awaited()
    conversations.projection.emit.assert_awaited_once()


async def test_interrupt_accepted_does_not_invent_idle() -> None:
    service, row, _dao, conversations = fixture()
    row.status = "running"
    conversations.actions.command.side_effect = [
        {"accepted": True},
        {"status": "running"},
    ]
    assert await service.interrupt(OWNER, row.id) == {"accepted": True}
    assert row.status == "running"
    assert [call.args[2] for call in conversations.actions.command.await_args_list] == [
        "interrupt",
        "state",
    ]
    conversations.projection.sync.assert_awaited_once()


@pytest.mark.parametrize("action", ["remove", "interrupt"])
async def test_missing_observation_cannot_override_a_newer_session(action: str) -> None:
    """网络请求结束前有并发提交时，缺失诊断不能覆盖新轮次或删除其记录。"""
    service, prior, dao, conversations = fixture()
    current = SessionRow(
        id=prior.id, owner_id=OWNER.user_id, source={}, state={}, status="starting", sequence=2
    )
    dao.session.side_effect = [prior, current] if action == "remove" else [current]
    conversations.actions.command.side_effect = RuntimeFailure("SESSION_NOT_FOUND", "synthetic")
    with pytest.raises(DomainError, match="会话状态已变化"):
        await getattr(service, action)(OWNER, prior.id)
    dao.clear_history.assert_not_awaited()
    conversations.projection.emit.assert_not_awaited()
    assert current.status == "starting" and not current.source
