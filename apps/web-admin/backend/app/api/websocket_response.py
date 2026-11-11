"""WebSocket握手拒绝保留HTTP错误码，已升级连接使用标准关闭码。"""

import asyncio
import contextlib

from starlette.responses import Response
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.infrastructure.errors import DomainError

CLOSE_TIMEOUT_SECONDS = 3.0


async def close_socket(socket: WebSocket, code: int, reason: str) -> None:
    """清理写入同样受期限限制；慢客户端不能把已超时或已撤权的订阅永久挂住。"""
    with contextlib.suppress(WebSocketDisconnect, RuntimeError, TimeoutError):
        async with asyncio.timeout(CLOSE_TIMEOUT_SECONDS):
            await socket.close(code, reason)


async def reject_socket(socket: WebSocket, error: DomainError) -> None:
    """支持ASGI拒绝响应扩展时返回原状态，不把所有未登录都折叠成403。"""
    try:
        if socket.application_state == WebSocketState.CONNECTING:
            if "websocket.http.response" in socket.scope.get("extensions", {}):
                async with asyncio.timeout(CLOSE_TIMEOUT_SECONDS):
                    await socket.send_denial_response(Response(status_code=error.status))
            else:
                await close_socket(socket, 1008, error.detail)
        elif socket.application_state == WebSocketState.CONNECTED:
            await close_socket(socket, 1008, "account authorization changed")
    except (WebSocketDisconnect, RuntimeError, TimeoutError):
        pass  # 对端已断开时不覆盖原始授权失败，也不重试写入关闭的连接。
