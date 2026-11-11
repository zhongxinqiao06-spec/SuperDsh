"""默认模型未提交与未知执行结果的外层收据边界，使用纯内存注入。"""

from __future__ import annotations

from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest

from app.integrations.dsh.protocol import RuntimeFailure
from app.modules.conversations.dao.conversation_dao import ConversationDao
from app.modules.conversations.entity.do.models import ConversationReceiptRow, SessionRow
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.conversations.service.execution_service import ExecutionService
from app.modules.identity.entity.bo.models import Account


@pytest.mark.parametrize(
    ("error", "released"),
    [
        (RuntimeFailure("model_default_invalid", "synthetic", 409), True),
        (RuntimeFailure("model_default_unavailable", "synthetic", 409), True),
        (RuntimeFailure("agent_default_invalid", "synthetic", 409), True),
        (RuntimeFailure("agent_default_unavailable", "synthetic", 409), True),
        (RuntimeFailure("permission_default_invalid", "synthetic", 409), True),
        (RuntimeFailure("permission_default_unavailable", "synthetic", 409), True),
        (RuntimeFailure("session_create_outcome_unknown", "synthetic", 409), False),
        (RuntimeFailure("runtime_not_ready", "synthetic", 409), False),
        (TimeoutError(), False),
    ],
)
async def test_creation_only_releases_confirmed_default_rejection(
    error: Exception, released: bool
) -> None:
    """通过完整 message 用例验证回滚，不能因泛化异常自动重新执行。"""
    row = SessionRow(
        id="synthetic-session",
        owner_id="synthetic-owner",
        connector_id="synthetic-connector",
        runtime_id="dsh",
        runtime_type="dsh",
        status="idle",
        source={},
        agent_binding=None,
        external_session_id=None,
        archived=False,
        takeover=True,
    )
    receipts: list[ConversationReceiptRow] = []
    dao = AsyncMock(spec=ConversationDao)
    dao.session.return_value = row
    dao.receipt.side_effect = lambda *_: receipts[0] if receipts else None

    async def save(value: object) -> None:
        if isinstance(value, ConversationReceiptRow):
            receipts.append(value)

    async def remove(value: ConversationReceiptRow) -> None:
        receipts.remove(value)

    dao.save.side_effect, dao.remove.side_effect = save, remove
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    conversations = Mock(spec=ConversationService)
    conversations.repository = Mock()
    conversations.repository.transaction.return_value = transaction
    conversations.own = AsyncMock(return_value=row)
    conversations.devices = Mock()
    conversations.devices.own = AsyncMock(return_value=Mock(executor_kind="server-agent"))
    conversations.devices.view.return_value = {"status": "online"}
    conversations.devices.call = AsyncMock(side_effect=error)
    conversations.projection = Mock()
    conversations.projection.emit = AsyncMock()
    service = ExecutionService(conversations)
    account = Account("synthetic-owner", "synthetic", (), ("sessions.run",), 1)
    with pytest.raises(type(error)) as caught:
        await service.message(
            account,
            row.id,
            {"clientMessageId": "synthetic-operation", "text": "synthetic-content"},
            create=True,
        )
    assert caught.value is error
    assert row.status == ("idle" if released else "starting")
    assert bool(receipts) is not released
    assert dao.remove.await_count == int(released)
    assert conversations.projection.emit.await_count == (2 if released else 1)


@pytest.mark.parametrize("changed", ["digest", "completed", "running", "external", "deleted"])
async def test_default_rejection_never_overwrites_changed_receipt_or_session(changed: str) -> None:
    """回滚使用事务锁并再次校验请求与会话状态，迟到拒绝不能擦除后继事实。"""
    receipt = ConversationReceiptRow(
        session_id="synthetic-session",
        operation_id="synthetic-operation",
        digest="different" if changed == "digest" else "synthetic-digest",
        state="completed" if changed == "completed" else "outcome_unknown",
        result=None,
    )
    row = SessionRow(
        source={"historyDeletedAt": "synthetic"} if changed == "deleted" else {},
        status="running" if changed == "running" else "starting",
        external_session_id="existing" if changed == "external" else None,
    )
    dao = AsyncMock(spec=ConversationDao)
    dao.receipt.return_value, dao.session.return_value = receipt, row
    transaction = AsyncMock()
    transaction.__aenter__.return_value = dao
    conversations = Mock()
    conversations.repository.transaction.return_value = transaction
    service = ExecutionService(cast(ConversationService, conversations))
    await service._release_unsubmitted_default(
        "synthetic-session", "synthetic-operation", "synthetic-digest"
    )
    dao.remove.assert_not_awaited()
    dao.lock.assert_awaited_once_with("synthetic-session")
