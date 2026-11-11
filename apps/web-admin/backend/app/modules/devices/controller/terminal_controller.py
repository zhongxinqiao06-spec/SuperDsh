"""设备与会话终端入口复用同一生命周期服务。"""

import asyncio
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect

from app.api.dependencies import current_account
from app.api.websocket_response import close_socket, reject_socket
from app.infrastructure.errors import DomainError
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.devices.entity.vo.device_dto import TerminalInput
from app.modules.devices.entity.vo.terminal_result import TerminalResult
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account

router = APIRouter(tags=["terminals"])
AccountDep = Annotated[Account, Depends(current_account)]


def devices(request: Request | WebSocket) -> DeviceService:
    return cast(DeviceService, request.app.state.services.devices)


def terminal_response(request: Request, value: object) -> object:
    """保存本次执行的设备协议表示，由集中入口声明选用；业务处理不读取版本或旧路径。"""
    if isinstance(value, TerminalResult):
        request.state.protocol_result = value.protocol_result
        return dict(value)
    return value


async def connector(
    request: Request | WebSocket, account: Account, target: str
) -> tuple[str, str | None]:
    if "/sessions/" in request.url.path:
        conversations = cast(ConversationService, request.app.state.services.conversations)
        session = await conversations.get_session(account, target)
        return str(session["connectorId"]), target
    await devices(request).own(account, target, "terminal.use")
    return target, None


async def terminal_target(
    request: Request | WebSocket, account: Account, target: str, identifier: str
) -> str:
    """终端 ID 必须属于当前路由所指的设备和会话。"""
    identity, session = await connector(request, account, target)
    await devices(request).terminals.authorize_scope(account, identity, identifier, session)
    return identity


@router.get("/connectors/{target_id}/terminals")
@router.get("/sessions/{target_id}/terminals")
async def listing(target_id: str, request: Request, account: AccountDep) -> object:
    identity, session = await connector(request, account, target_id)
    return terminal_response(
        request, await devices(request).terminals.listing(account, identity, session)
    )


@router.post("/connectors/{target_id}/terminals")
@router.post("/sessions/{target_id}/terminals")
async def create(
    target_id: str, value: TerminalInput, request: Request, account: AccountDep
) -> object:
    identity, session = await connector(request, account, target_id)
    if session:
        conversations = cast(ConversationService, request.app.state.services.conversations)
        bound = await conversations.get_session(account, session)
        value = value.model_copy(update={"sessionId": session, "root": str(bound.get("cwd", "."))})
    else:
        # 设备浏览与业务会话使用不同终端作用域，忽略请求体伪造的sessionId。
        value = value.model_copy(update={"sessionId": "browse_" + identity})
    if not session and request.query_params.get("root"):
        value = value.model_copy(update={"root": request.query_params["root"]})
    return terminal_response(
        request, await devices(request).terminals.create(account, identity, value)
    )


@router.patch("/connectors/{target_id}/terminals/{terminal_id}")
@router.patch("/sessions/{target_id}/terminals/{terminal_id}")
async def rename(
    target_id: str,
    terminal_id: str,
    value: dict[str, object],
    request: Request,
    account: AccountDep,
) -> object:
    identity = await terminal_target(request, account, target_id, terminal_id)
    return terminal_response(
        request,
        await devices(request).terminals.action(account, identity, terminal_id, "rename", value),
    )


@router.delete("/connectors/{target_id}/terminals/{terminal_id}")
@router.delete("/sessions/{target_id}/terminals/{terminal_id}")
async def remove(target_id: str, terminal_id: str, request: Request, account: AccountDep) -> object:
    identity = await terminal_target(request, account, target_id, terminal_id)
    return terminal_response(
        request,
        await devices(request).terminals.action(account, identity, terminal_id, "close", {}),
    )


@router.post("/connectors/{target_id}/terminals/{terminal_id}/resize")
@router.post("/sessions/{target_id}/terminals/{terminal_id}/resize")
async def resize(
    target_id: str,
    terminal_id: str,
    value: dict[str, object],
    request: Request,
    account: AccountDep,
) -> object:
    identity = await terminal_target(request, account, target_id, terminal_id)
    return terminal_response(
        request,
        await devices(request).terminals.action(account, identity, terminal_id, "resize", value),
    )


@router.patch("/connectors/{target_id}/terminals/{terminal_id}/persistence")
@router.patch("/sessions/{target_id}/terminals/{terminal_id}/persistence")
async def persistence(
    target_id: str,
    terminal_id: str,
    value: dict[str, object],
    request: Request,
    account: AccountDep,
) -> object:
    identity = await terminal_target(request, account, target_id, terminal_id)
    return terminal_response(
        request,
        await devices(request).terminals.action(
            account, identity, terminal_id, "persistence", value
        ),
    )


@router.post("/connectors/{target_id}/terminals/{terminal_id}/write")
@router.post("/sessions/{target_id}/terminals/{terminal_id}/write")
async def write(
    target_id: str,
    terminal_id: str,
    value: dict[str, object],
    request: Request,
    account: AccountDep,
) -> object:
    identity = await terminal_target(request, account, target_id, terminal_id)
    return terminal_response(
        request,
        await devices(request).terminals.action(account, identity, terminal_id, "write", value),
    )


@router.get("/connectors/{target_id}/terminals/{terminal_id}/snapshot")
@router.get("/sessions/{target_id}/terminals/{terminal_id}/snapshot")
async def snapshot(
    target_id: str,
    terminal_id: str,
    request: Request,
    account: AccountDep,
    afterSeq: int = 0,
    fromSeq: int | None = None,
) -> object:
    identity = await terminal_target(request, account, target_id, terminal_id)
    return terminal_response(
        request,
        await devices(request).terminals.snapshot(
            account, identity, terminal_id, max(0, fromSeq if fromSeq is not None else afterSeq)
        ),
    )


@router.websocket("/connectors/{target_id}/terminals/{terminal_id}/stream")
@router.websocket("/sessions/{target_id}/terminals/{terminal_id}/stream")
async def stream(target_id: str, terminal_id: str, socket: WebSocket) -> None:
    device_service = devices(socket)
    token = socket.headers.get("authorization", "").removeprefix(
        "Bearer "
    ) or socket.query_params.get("token", "")
    try:
        account = await device_service.identity.authenticate(token)
        identity = await terminal_target(socket, account, target_id, terminal_id)
        after = max(
            0, int(socket.query_params.get("fromSeq", socket.query_params.get("afterSeq", "0")))
        )
        initial = await device_service.terminals.snapshot(account, identity, terminal_id, after)
        await socket.accept()
        if isinstance(initial, dict):
            await asyncio.wait_for(
                socket.send_json(
                    {
                        "type": "replay",
                        "data": initial.get("dataBase64", ""),
                        "seq": initial.get("seq", initial.get("sequence", after)),
                        "reset": initial.get("reset", False),
                    }
                ),
                10,
            )
            after = int(str(initial.get("sequence", initial.get("seq", after))))
        while True:
            account = await device_service.identity.authenticate(token)
            result = await device_service.terminals.snapshot(account, identity, terminal_id, after)
            if isinstance(result, dict) and (result.get("data") or result.get("reset")):
                await asyncio.wait_for(
                    socket.send_json(
                        {
                            "type": "output",
                            **result,
                            "data": result.get("dataBase64", ""),
                            "seq": result.get("seq", result.get("sequence", after)),
                        }
                    ),
                    10,
                )
                after = int(str(result.get("sequence", after)))
            try:
                frame = await asyncio.wait_for(socket.receive_json(), 0.25)
                if isinstance(frame, dict):
                    kind = frame.get("type")
                    if kind in {"input", "write"}:
                        await device_service.terminals.action(
                            account,
                            identity,
                            terminal_id,
                            "write",
                            {"dataBase64": frame.get("data")},
                        )
                    elif kind == "resize":
                        await device_service.terminals.action(
                            account, identity, terminal_id, "resize", frame
                        )
                    elif kind == "ping":
                        await asyncio.wait_for(socket.send_json({"type": "pong"}), 10)
                    else:
                        raise DomainError(422, "unsupported terminal message")
            except TimeoutError:
                continue
    except DomainError as error:
        await reject_socket(socket, error)
    except (WebSocketDisconnect, RuntimeError, TimeoutError, ValueError):
        await close_socket(socket, 1008, "terminal subscription ended")
