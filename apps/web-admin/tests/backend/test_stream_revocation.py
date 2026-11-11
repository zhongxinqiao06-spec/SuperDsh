"""真实流控制器配合可控传输端口：复验逐帧撤权与有界关闭，不冒充网络或真机覆盖。"""

import asyncio
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.api import websocket_response
from app.infrastructure.errors import DomainError
from app.modules.conversations.controller import stream_controller
from app.modules.identity.entity.bo.models import Account

ACCOUNT = Account("synthetic-owner", "synthetic", (), ("sessions.read",), 1)


def stream_fixture(monkeypatch: pytest.MonkeyPatch) -> tuple[Mock, Mock]:
    """只替换身份/存储/网络端口，批量发送、授权时机与异常退出执行真实控制器。"""
    conversations = Mock()
    conversations.tickets.consume = AsyncMock(
        return_value=(ACCOUNT, "original-credential", "client")
    )
    conversations.devices.identity.authenticate = AsyncMock(return_value=ACCOUNT)
    conversations.own = AsyncMock()
    conversations.events = AsyncMock(
        return_value={
            "events": [{"type": "message", "sequence": index} for index in (1, 2, 3)],
            "hasMore": False,
        }
    )
    subscription = Mock()
    subscription.subscribed = AsyncMock(return_value={"type": "session.subscribed", "sequence": 0})
    monkeypatch.setattr(stream_controller, "SubscriptionService", lambda _: subscription)
    socket = Mock(spec=WebSocket)
    socket.app = SimpleNamespace(
        state=SimpleNamespace(services=SimpleNamespace(conversations=conversations))
    )
    socket.query_params = {"ticket": "synthetic-ticket", "after": "0"}
    socket.application_state = WebSocketState.CONNECTED
    socket.accept = AsyncMock()
    socket.send_json = AsyncMock()
    socket.close = AsyncMock()
    socket.receive_json = AsyncMock(side_effect=WebSocketDisconnect())
    return conversations, socket


@pytest.mark.parametrize("change", ["login", "permission", "ownership"])
async def test_revocation_after_one_cached_event_stops_remaining_page(
    change: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """同页已加载三条事件，第1条发送后发生撤权，第2、3条仍必须立即停止。"""
    conversations, socket = stream_fixture(monkeypatch)
    revoked = False
    sent: list[int] = []

    async def authenticate(credential: str) -> Account:
        assert credential == "original-credential"
        if revoked and change == "login":
            raise DomainError(401, "login revoked")
        if revoked and change == "permission":
            return Account(ACCOUNT.user_id, ACCOUNT.username, (), (), 1)
        return ACCOUNT

    async def own(account: Account, session: str) -> object:
        assert account.user_id == ACCOUNT.user_id and session == "synthetic-session"
        if revoked and change == "ownership":
            raise DomainError(404, "session not found")
        return {}

    async def send(frame: dict[str, object]) -> None:
        nonlocal revoked
        if frame.get("type") == "message":
            sent.append(int(str(frame["sequence"])))
            revoked = True

    conversations.devices.identity.authenticate.side_effect = authenticate
    conversations.own.side_effect = own
    socket.send_json.side_effect = send
    await stream_controller.session_stream("synthetic-session", cast(WebSocket, socket))
    assert sent == [1]
    assert conversations.events.await_count == 1
    socket.close.assert_awaited_once_with(1008, "account authorization changed")


async def test_send_timeout_cannot_hang_again_while_closing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """发送已经超时，关闭也背压时仍结束真实订阅任务，而不是永久占用连接任务。"""
    _, socket = stream_fixture(monkeypatch)
    monkeypatch.setattr(websocket_response, "CLOSE_TIMEOUT_SECONDS", 0.01)
    cancelled = asyncio.Event()

    async def blocked_close(*_args: object) -> None:
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    socket.send_json.side_effect = TimeoutError()
    socket.close.side_effect = blocked_close
    await asyncio.wait_for(
        stream_controller.session_stream("synthetic-session", cast(WebSocket, socket)), 1
    )
    socket.close.assert_awaited_once_with(1013, "slow client; reconnect to recover")
    assert cancelled.is_set()


async def test_dashboard_discards_snapshot_built_before_permission_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """快照组装期间移除会话读取权限，不得把旧权限组装出的内容发送给当前连接。"""
    conversations, socket = stream_fixture(monkeypatch)
    full = Account(ACCOUNT.user_id, ACCOUNT.username, (), ("devices.read", "sessions.read"), 1)
    limited = Account(ACCOUNT.user_id, ACCOUNT.username, (), ("devices.read",), 1)
    conversations.tickets.consume.return_value = (full, "original-credential", "client")
    conversations.devices.identity.authenticate.side_effect = [full, limited, limited, limited]
    subscription = Mock()

    async def dashboard(account: Account) -> dict[str, object]:
        return {
            "type": "dashboard.snapshot",
            "sessions": ["private-session"] if "sessions.read" in account.permissions else [],
        }

    subscription.dashboard = AsyncMock(side_effect=dashboard)
    monkeypatch.setattr(stream_controller, "SubscriptionService", lambda _: subscription)
    socket.receive_text = AsyncMock(side_effect=WebSocketDisconnect())
    await stream_controller.dashboard_stream(cast(WebSocket, socket))
    assert subscription.dashboard.await_count == 2
    socket.send_json.assert_awaited_once_with({"type": "dashboard.snapshot", "sessions": []})


@pytest.mark.parametrize(
    "state,extension",
    [
        (WebSocketState.CONNECTING, True),
        (WebSocketState.CONNECTING, False),
        (WebSocketState.CONNECTED, False),
    ],
)
async def test_rejection_preserves_handshake_status_and_bounds_cleanup(
    state: WebSocketState,
    extension: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """401握手扩展与1008关闭保持原语义，两种拒绝写入都使用统一短期限。"""
    monkeypatch.setattr(websocket_response, "CLOSE_TIMEOUT_SECONDS", 0.01)
    socket = Mock(spec=WebSocket)
    socket.application_state = state
    socket.scope = {"extensions": {"websocket.http.response": {}} if extension else {}}
    cancelled = asyncio.Event()

    async def blocked(*_args: object) -> None:
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    socket.close = AsyncMock(side_effect=blocked)
    socket.send_denial_response = AsyncMock(side_effect=blocked)
    await asyncio.wait_for(
        websocket_response.reject_socket(
            cast(WebSocket, socket), DomainError(401, "invalid ticket")
        ),
        1,
    )
    if extension:
        assert socket.send_denial_response.await_args.args[0].status_code == 401
        socket.close.assert_not_awaited()
    else:
        socket.close.assert_awaited_once_with(
            1008,
            "invalid ticket"
            if state == WebSocketState.CONNECTING
            else "account authorization changed",
        )
    assert cancelled.is_set()


async def test_close_does_not_swallow_task_cancellation() -> None:
    """服务关闭的取消信号直接传播，不被正常清理错误容忍逻辑吞掉。"""
    socket = Mock(spec=WebSocket)
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def blocked(*_args: object) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    socket.close = AsyncMock(side_effect=blocked)
    task = asyncio.create_task(
        websocket_response.close_socket(cast(WebSocket, socket), 1008, "closed")
    )
    try:
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cancelled.is_set()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
