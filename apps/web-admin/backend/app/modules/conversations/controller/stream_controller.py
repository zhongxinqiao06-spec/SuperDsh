"""有界WebSocket协议转换，首帧和保活沿用现有客户端契约。"""

import asyncio
from datetime import UTC, datetime
from time import monotonic
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect

from app.api.dependencies import current_account
from app.api.websocket_response import close_socket, reject_socket
from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.vo.conversation_dto import TicketInput
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.conversations.service.subscription_service import SubscriptionService
from app.modules.identity.entity.bo.models import Account

router = APIRouter(tags=["conversation-streams"])
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request | WebSocket) -> ConversationService:
    """控制器仅取得公开领域入口，不直接读写持久层。"""
    return cast(ConversationService, request.app.state.services.conversations)


@router.post("/ws-ticket")
async def ticket(value: TicketInput, request: Request, account: AccountDep) -> object:
    """票据绑定当前访问凭据、客户端和作用域，不触发引擎启动。"""
    return await service(request).tickets.issue(
        account,
        request.headers.get("authorization", "").removeprefix("Bearer "),
        value.clientId,
        value.scope,
    )


async def send_frame(socket: WebSocket, frame: dict[str, object]) -> None:
    """生产者等待有界发送，不累积无界队列；慢客户端重新连接恢复持久事件。"""
    await asyncio.wait_for(socket.send_json(frame), 10)


async def finish_timeout(socket: WebSocket) -> None:
    """发送期限耗尽后只给关闭帧短宽限期，随后释放订阅任务。"""
    await close_socket(socket, 1013, "slow client; reconnect to recover")


async def send_session_frame(
    socket: WebSocket,
    conversations: ConversationService,
    credential: str,
    session_id: str,
    frame: dict[str, object],
) -> None:
    """每帧重新检查原登录、当前权限与资源归属，分页缓存不延长旧授权的有效期。"""
    account = await conversations.devices.identity.authenticate(credential)
    account.require("sessions.read")
    await conversations.own(account, session_id)
    await send_frame(socket, frame)


@router.websocket("/sessions/{session_id}/ws")
async def session_stream(session_id: str, socket: WebSocket) -> None:
    """票据中已有clientId；旧桌面仅在URL发送ticket也可以建立订阅。"""
    conversations = service(socket)
    subscription = SubscriptionService(conversations)
    try:
        account, token, client_id = await conversations.tickets.consume(
            socket.query_params.get("ticket", ""),
            socket.query_params.get("clientId", ""),
            {"sessionId": session_id},
        )
        first = await subscription.subscribed(account, session_id, client_id)
        raw_cursor = socket.query_params.get("cursor", socket.query_params.get("after"))
        after = int(raw_cursor.removeprefix("seq:")) if raw_cursor else int(str(first["sequence"]))
        if after < 0:
            raise DomainError(422, "invalid session cursor")
        await socket.accept()
        await send_session_frame(socket, conversations, token, session_id, first)
        heartbeat = monotonic()
        while True:
            account = await conversations.devices.identity.authenticate(token)
            account.require("sessions.read")
            page = await conversations.events(account, session_id, after)
            events = page["events"]
            assert isinstance(events, list)
            for event in events:
                assert isinstance(event, dict)
                await send_session_frame(socket, conversations, token, session_id, event)
                after = int(str(event["sequence"]))
            if monotonic() - heartbeat >= 15:
                await send_session_frame(
                    socket,
                    conversations,
                    token,
                    session_id,
                    {"type": "keepalive", "serverTime": datetime.now(UTC).isoformat()},
                )
                heartbeat = monotonic()
            if page["hasMore"]:
                continue
            try:
                frame = await asyncio.wait_for(socket.receive_json(), 1)
            except TimeoutError:
                continue
            if isinstance(frame, dict) and frame.get("type") == "ping":
                await send_session_frame(socket, conversations, token, session_id, {"type": "pong"})
    except DomainError as error:
        await reject_socket(socket, error)
    except ValueError:
        await reject_socket(socket, DomainError(422, "invalid session cursor"))
    except TimeoutError:
        await finish_timeout(socket)
    except (WebSocketDisconnect, RuntimeError):
        pass


@router.websocket("/dashboard/ws")
async def dashboard_stream(socket: WebSocket) -> None:
    """完整工作台快照保留原字段，快照不变时只发送有界保活。"""
    conversations = service(socket)
    subscription = SubscriptionService(conversations)
    try:
        account, token, _ = await conversations.tickets.consume(
            socket.query_params.get("ticket", ""),
            socket.query_params.get("clientId", ""),
            {"dashboard": True},
        )
        await socket.accept()
        prior: object = None
        heartbeat = monotonic()
        while True:
            account = await conversations.devices.identity.authenticate(token)
            snapshot = await subscription.dashboard(account)
            # 组装可能等待设备与数据库；期间角色收紧时丢弃旧快照并按新权限重建。
            current = await conversations.devices.identity.authenticate(token)
            current.require("devices.read")
            if current.permissions != account.permissions:
                continue
            comparable = {key: value for key, value in snapshot.items() if key != "serverTime"}
            if comparable != prior:
                await send_frame(socket, snapshot)
                prior = comparable
            if monotonic() - heartbeat >= 15:
                await send_frame(
                    socket, {"type": "keepalive", "serverTime": datetime.now(UTC).isoformat()}
                )
                heartbeat = monotonic()
            try:
                await asyncio.wait_for(socket.receive_text(), 2)
            except TimeoutError:
                continue
    except DomainError as error:
        await reject_socket(socket, error)
    except TimeoutError:
        await finish_timeout(socket)
    except (WebSocketDisconnect, RuntimeError):
        pass
