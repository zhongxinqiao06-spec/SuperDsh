"""设备文件传输、短期预览与 Shell 收据的 HTTP/WS 协议转换。"""

from typing import Annotated, cast
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request, WebSocket
from starlette.responses import Response

from app.api.dependencies import current_account
from app.api.websocket_response import reject_socket
from app.infrastructure.errors import DomainError
from app.modules.devices.entity.vo.device_dto import FileRequest
from app.modules.devices.entity.vo.operation_vo import PreviewExchange, PreviewRead, ShellInput
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account

router = APIRouter(tags=["device-operations"])
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request | WebSocket) -> DeviceService:
    """只取得公开用例，不在路由中读取数据库或宿主文件。"""
    return cast(DeviceService, request.app.state.services.devices)


def credential(request: Request) -> str:
    """短期派生票据持有原登录上下文，不能绕过会话撤销。"""
    return request.headers.get("authorization", "").removeprefix("Bearer ")


@router.post("/connectors/{connector_id}/fs/read")
async def prepare(
    connector_id: str,
    value: FileRequest,
    request: Request,
    account: AccountDep,
    root: str | None = None,
) -> object:
    """返回固定文件传输描述符，实际内容通过一次性下载地址取得。"""
    if root is not None:
        value = value.model_copy(update={"root": root})
    return await service(request).operations.files.prepare(
        account, credential(request), connector_id, value
    )


@router.post("/connectors/{connector_id}/fs/preview-token")
async def issue_preview(
    connector_id: str,
    value: FileRequest,
    request: Request,
    account: AccountDep,
    root: str | None = None,
) -> object:
    """预览入口令牌只允许兑换一次。"""
    if root is not None:
        value = value.model_copy(update={"root": root})
    return await service(request).operations.files.issue(
        account, credential(request), connector_id, value
    )


@router.post("/connectors/fs/preview-session")
async def preview_session(value: PreviewExchange, request: Request) -> object:
    """公开兑换接口只接纳平台签发的短期票据。"""
    return await service(request).operations.files.exchange(value.previewToken)


@router.post("/connectors/fs/preview/read")
async def preview_read(value: PreviewRead, request: Request) -> object:
    """不能用预览会话读取绑定路径以外的文件。"""
    return await service(request).operations.files.preview(
        value.previewAccessToken, False, value.maxBytes
    )


@router.post("/connectors/fs/preview/readText")
async def preview_text(value: PreviewRead, request: Request) -> object:
    """预览文本遵循原编码和大小限制。"""
    return await service(request).operations.files.preview(
        value.previewAccessToken, True, value.maxBytes
    )


@router.put("/connector/fs/transfers/{transfer_id}")
async def receive(transfer_id: str, request: Request, token: str = "") -> object:
    """二进制请求流直接交由有界校验器，控制器不完整缓存文件。"""
    return await service(request).operations.files.receive(
        transfer_id, token, credential(request), request.stream()
    )


@router.get("/connectors/{connector_id}/fs/transfers/{transfer_id}")
async def download(
    connector_id: str, transfer_id: str, request: Request, token: str = ""
) -> Response:
    """下载票据限定文件和原会话，输出强制附件和禁止主动内容执行。"""
    content, metadata = await service(request).operations.files.download(
        connector_id, transfer_id, token
    )
    media = (
        str(metadata.get("mediaType", "application/octet-stream"))
        .replace("\r", "")
        .replace("\n", "")
    )
    return Response(
        content,
        media_type=media,
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''"
            + quote(str(metadata.get("name", "download"))),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/connectors/{connector_id}/protocol/capabilities")
async def retired_capabilities(connector_id: str, request: Request, account: AccountDep) -> object:
    """保留旧入口的明确退役语义，权限核验先于退役响应。"""
    await service(request).own(account, connector_id)
    raise DomainError(410, "use /connectors/{connector_id}/runtimes/{runtime_id}/capabilities")


@router.post("/connectors/{connector_id}/shell/exec")
async def execute(
    connector_id: str,
    value: ShellInput,
    request: Request,
    account: AccountDep,
    root: str | None = None,
) -> object:
    """同步 Shell 仍登记稳定收据，网络断开不会自动重新提交。"""
    if root is not None:
        value = value.model_copy(update={"root": root})
    return await service(request).operations.shell.execute(
        account, credential(request), connector_id, value
    )


@router.post("/connectors/{connector_id}/shell/tasks")
async def start(
    connector_id: str,
    value: ShellInput,
    request: Request,
    account: AccountDep,
    root: str | None = None,
) -> object:
    """异步命令先提交持久意图，再返回可查询的任务身份。"""
    if root is not None:
        value = value.model_copy(update={"root": root})
    return await service(request).operations.shell.start(
        account, credential(request), connector_id, value
    )


@router.get("/connectors/{connector_id}/shell/tasks/{task_id}/wait")
async def wait(
    connector_id: str,
    task_id: str,
    request: Request,
    account: AccountDep,
    timeoutMs: Annotated[int, Query(ge=1, le=300000)] = 120000,
) -> object:
    """有界等待读取原任务，过程中持续重新授权。"""
    return await service(request).operations.shell.wait(
        account, credential(request), connector_id, task_id, timeoutMs
    )


@router.websocket("/connector/terminals/{terminal_id}/relay")
async def relay(terminal_id: str, socket: WebSocket) -> None:
    """设备通过短期 Relay 票据接入，与用户终端 WebSocket 分离。"""
    try:
        await service(socket).operations.relay.serve(
            terminal_id, socket.query_params.get("token", ""), socket
        )
    except DomainError as error:
        await reject_socket(socket, error)
